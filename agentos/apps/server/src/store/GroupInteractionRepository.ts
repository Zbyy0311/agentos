import {
  GROUP_STOP_REASONS,
  LOOP_GUARD_SIGNALS,
  validateGroupInteractionBudget,
  type GroupInteractionBudgetV1,
  type GroupStopReason,
  type LoopGuardSignal,
} from '@agentos/shared';
import { createHash } from 'node:crypto';
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
export type GroupExecutionStatus = 'claimed' | 'running' | 'stop_requested' | 'completed' | 'failed' | 'interrupted' | 'abandoned';

export interface GroupExecutionOwnerRecord {
  readonly interactionId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly sourceMessageId: string | null;
  readonly ownerId: string;
  readonly ownerEpoch: number;
  readonly participantAgentIds: readonly string[];
  readonly budget: Readonly<Record<string, number | null>>;
  readonly status: GroupExecutionStatus;
  readonly currentAgentId: string | null;
  readonly currentTurnId: string | null;
  readonly currentMessageId: string | null;
  readonly eventCursor: number;
  readonly terminalReason: string | null;
  readonly updatedAt: string;
}

export interface GroupExecutionEventRecord {
  readonly interactionId: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly cursor: number;
  readonly ownerEpoch: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface GroupInteractionRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly sourceMessageId: string | null;
  readonly integrityStatus: 'valid' | 'unusable';
  readonly integrityReason: string | null;
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
  readonly ownerId: string | null;
  readonly ownerEpoch: number | null;
  readonly integrityStatus: 'valid' | 'unusable';
  readonly integrityReason: string | null;
  readonly createdAt: string;
}

export interface CreateGroupInteractionInput {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly budget: GroupInteractionBudgetV1;
  readonly sourceMessageId?: string;
  readonly createdAt: string;
  /** Internal recovery-only exception for the exact interrupted owner being superseded. */
  readonly recoverySupersedesInterrupted?: {
    readonly interactionId: string;
    readonly ownerId: string;
    readonly ownerEpoch: number;
  };
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
  readonly ownerId?: string;
  readonly ownerEpoch?: number;
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

export interface ClaimGroupExecutionInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly interactionId: string;
  readonly sourceMessageId: string;
  readonly participantAgentIds: readonly string[];
  /** Internal empty-plan finalization only; it never starts a Provider Turn. */
  readonly allowEmptyParticipants?: boolean;
  readonly ownerId: string;
  readonly createdAt: string;
}

export interface RecordGroupProviderProcessInput {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly ownerId: string;
  readonly ownerEpoch: number;
  readonly turnId: string;
  readonly agentId: string;
  readonly invocationId: string;
  readonly pid: number;
  readonly nativeBirthIdentity: string;
  readonly startedAt: string;
}

export interface GroupExecutionOwnerInput {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly ownerId: string;
  readonly ownerEpoch: number;
  readonly updatedAt: string;
}

export interface GroupExecutionTransitionInput extends GroupExecutionOwnerInput {
  readonly status: GroupExecutionStatus;
  readonly eventType: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly terminalReason?: string | null;
  readonly currentAgentId?: string | null;
  readonly currentTurnId?: string | null;
  readonly currentMessageId?: string | null;
}

export interface GroupExecutionEventInput extends GroupExecutionOwnerInput {
  readonly eventType: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface RequestGroupStopInput {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly ownerId: string;
  readonly ownerEpoch: number;
  readonly expectedVersion: number;
  readonly stoppedAt: string;
}

export type GroupInteractionRepositoryErrorCode =
  | 'INTERACTION_INPUT_INVALID'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_NOT_TRANSITIONABLE'
  | 'INTERACTION_UNUSABLE'
  | 'INTERACTION_SOURCE_MISMATCH'
  | 'CONVERSATION_NOT_ACTIVE_GROUP'
  | 'GROUP_VERSION_CONFLICT'
  | 'EXECUTION_ALREADY_OWNED'
  | 'EXECUTION_INTERRUPTED'
  | 'EXECUTION_STALE_OWNER'
  | 'ACTIVE_INTERACTION_EXISTS'
  | 'REPLY_INPUT_INVALID'
  | 'GROUP_REPLY_ASSOCIATION_INVALID'
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
  source_message_id: string | null;
  integrity_status: string;
  integrity_reason: string | null;
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
  owner_id: string | null;
  owner_epoch: number | null;
  integrity_status: string;
  integrity_reason: string | null;
  created_at: string;
}

interface ExecutionRow {
  interaction_id: string;
  workspace_id: string;
  conversation_id: string;
  source_message_id: string | null;
  owner_id: string;
  owner_epoch: number;
  participants_json: string;
  budget_json: string;
  status: string;
  current_agent_id: string | null;
  current_turn_id: string | null;
  current_message_id: string | null;
  event_cursor: number;
  terminal_reason: string | null;
  updated_at: string;
}

interface EventRow {
  interaction_id: string;
  workspace_id: string;
  conversation_id: string;
  cursor: number;
  owner_epoch: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface ReplyAssociationRow {
  interaction_id: string;
  workspace_id: string;
  conversation_id: string;
  source_message_id: string | null;
  interaction_integrity: string;
  message_id: string;
  message_workspace_id: string;
  message_conversation_id: string;
  message_sender_type: string;
  message_sender_agent_id: string | null;
  message_status: string;
  message_content: string;
  message_reply_to_id: string | null;
  turn_id: string;
  turn_workspace_id: string;
  turn_conversation_id: string;
  turn_agent_id: string;
  turn_status: string;
  turn_message_id: string;
  execution_owner_id: string;
  execution_owner_epoch: number;
  execution_current_agent_id: string | null;
  execution_current_turn_id: string | null;
  execution_current_message_id: string | null;
  execution_status: string;
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
      return inTransaction(this.db, () => this.createInteractionWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /** Transaction-free variant used by the atomic group-message command. */
  createInteractionWithinTransaction(input: CreateGroupInteractionInput): GroupInteractionRecord {
    if (!nonBlank(input.id) || !nonBlank(input.conversationId) || !nonBlank(input.workspaceId)
      || !nonBlank(input.createdAt)) throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    const budgetCheck = validateGroupInteractionBudget(input.budget);
    if (!budgetCheck.valid) throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    if (!nonBlank(input.sourceMessageId)) throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    this.assertActiveGroupSource(input.workspaceId, input.conversationId, input.sourceMessageId);
    this.assertNoOtherActiveInteraction(
      input.workspaceId, input.conversationId, undefined, input.recoverySupersedesInterrupted,
    );
    this.db.prepare(
      `INSERT INTO cr_group_interactions (
        id, conversation_id, workspace_id, source_message_id, max_agents_per_turn,
        max_replies_per_agent, max_total_replies, max_agent_hops, timeout_ms,
        context_token_budget, reply_count, hop_count, status, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', 1, ?, ?)`,
    ).run(
      input.id, input.conversationId, input.workspaceId, input.sourceMessageId ?? null,
      input.budget.maxAgentsPerTurn, input.budget.maxRepliesPerAgent,
      input.budget.maxTotalReplies, input.budget.maxAgentHops,
      input.budget.timeoutMs ?? null, input.budget.contextTokenBudget ?? null,
      input.createdAt, input.createdAt,
    );
    return this.requireInteraction(input.workspaceId, input.id);
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

  findInteractionBySourceMessage(workspaceId: string, conversationId: string, sourceMessageId: string): GroupInteractionRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(conversationId) || !nonBlank(sourceMessageId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_group_interactions WHERE workspace_id = ? AND conversation_id = ? AND source_message_id = ?',
    ).get(workspaceId, conversationId, sourceMessageId) as InteractionRow | undefined;
    return row === undefined ? undefined : toInteractionRecord(row);
  }

  /** Durable CAS claim; BEGIN IMMEDIATE serializes independent SQLite connections. */
  claimExecution(input: ClaimGroupExecutionInput): GroupExecutionOwnerRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.conversationId)
      || !nonBlank(input.interactionId) || !nonBlank(input.sourceMessageId)
      || !nonBlank(input.ownerId) || !nonBlank(input.createdAt)
      || (input.participantAgentIds.length === 0 && input.allowEmptyParticipants !== true)
      || input.participantAgentIds.some(id => !nonBlank(id))) {
      throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        const interaction = this.requireInteraction(input.workspaceId, input.interactionId);
        if (interaction.integrityStatus !== 'valid') throw new GroupInteractionRepositoryError('INTERACTION_UNUSABLE');
        if (interaction.conversationId !== input.conversationId) throw new GroupInteractionRepositoryError('INTERACTION_NOT_FOUND');
        if (interaction.sourceMessageId !== input.sourceMessageId) throw new GroupInteractionRepositoryError('INTERACTION_SOURCE_MISMATCH');
        this.assertActiveGroupSource(input.workspaceId, input.conversationId, input.sourceMessageId);
        this.assertNoOtherActiveInteraction(input.workspaceId, input.conversationId, interaction.id);
        if (interaction.status !== 'active') throw new GroupInteractionRepositoryError('INTERACTION_NOT_TRANSITIONABLE');
        const existing = this.findExecutionOwner(input.workspaceId, input.interactionId);
        if (existing !== undefined) {
          throw new GroupInteractionRepositoryError(existing.status === 'interrupted'
            ? 'EXECUTION_INTERRUPTED'
            : 'EXECUTION_ALREADY_OWNED');
        }
        const ownerId = input.ownerId;
        const ownerEpoch = 1;
        this.db.prepare(`
          INSERT INTO cr_group_interaction_executions (
            interaction_id, workspace_id, conversation_id, source_message_id, owner_id,
            owner_epoch, participants_json, budget_json, status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?)
        `).run(
          interaction.id, interaction.workspaceId, interaction.conversationId, interaction.sourceMessageId,
          ownerId, ownerEpoch, JSON.stringify([...new Set(input.participantAgentIds)]),
          JSON.stringify({
            maxAgentsPerTurn: interaction.maxAgentsPerTurn,
            maxRepliesPerAgent: interaction.maxRepliesPerAgent,
            maxTotalReplies: interaction.maxTotalReplies,
            maxAgentHops: interaction.maxAgentHops,
            timeoutMs: interaction.timeoutMs,
            contextTokenBudget: interaction.contextTokenBudget,
          }), input.createdAt,
        );
        this.appendExecutionEventWithinTransaction({
          workspaceId: input.workspaceId,
          interactionId: input.interactionId,
          ownerId,
          ownerEpoch,
          eventType: 'group.claimed',
          payload: { participantAgentIds: [...new Set(input.participantAgentIds)] },
          updatedAt: input.createdAt,
        });
        return this.requireExecutionOwner(input.workspaceId, input.interactionId);
      });
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new GroupInteractionRepositoryError('EXECUTION_ALREADY_OWNED');
      }
      throw this.publicError(error);
    }
  }

  findExecutionOwner(workspaceId: string, interactionId: string): GroupExecutionOwnerRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(interactionId)) return undefined;
    const row = this.db.prepare(`
      SELECT * FROM cr_group_interaction_executions WHERE workspace_id = ? AND interaction_id = ?
    `).get(workspaceId, interactionId) as ExecutionRow | undefined;
    return row === undefined ? undefined : toExecutionRecord(row);
  }

  /**
   * Bind a real native Provider process to the durable owner and current Turn.
   * This is called immediately after the atomic Windows Job spawn; a stale
   * owner/Turn must never be able to append process identity under a newer
   * execution claim.
   */
  recordProviderProcessStarted(input: RecordGroupProviderProcessInput): GroupExecutionEventRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.interactionId) || !nonBlank(input.ownerId)
      || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1
      || !nonBlank(input.turnId) || !nonBlank(input.agentId) || !nonBlank(input.invocationId)
      || !Number.isSafeInteger(input.pid) || input.pid <= 0 || !nonBlank(input.startedAt)
      || !/^win32:filetime:(0|[1-9][0-9]*)$/u.test(input.nativeBirthIdentity)) {
      throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    }
    return inTransaction(this.db, () => {
      const owner = this.requireExecutionOwner(input.workspaceId, input.interactionId);
      if (owner.ownerId !== input.ownerId || owner.ownerEpoch !== input.ownerEpoch
        || owner.status !== 'running' || owner.currentTurnId !== input.turnId
        || owner.currentAgentId !== input.agentId) {
        throw new GroupInteractionRepositoryError('EXECUTION_STALE_OWNER');
      }
      return this.appendExecutionEventWithinTransaction({
        workspaceId: input.workspaceId,
        interactionId: input.interactionId,
        ownerId: input.ownerId,
        ownerEpoch: input.ownerEpoch,
        eventType: 'group.provider.started',
        payload: {
          turnId: input.turnId,
          agentId: input.agentId,
          invocationId: input.invocationId,
          pid: input.pid,
          nativeBirthIdentity: input.nativeBirthIdentity,
        },
        updatedAt: input.startedAt,
      });
    });
  }

  transitionExecutionWithinTransaction(input: GroupExecutionTransitionInput): GroupExecutionOwnerRecord {
    this.assertOwner(input);
    if (!nonBlank(input.eventType)) throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    const current = this.requireExecutionOwner(input.workspaceId, input.interactionId);
    const recoveryAbandon = current.status === 'interrupted'
      && input.status === 'abandoned' && input.eventType === 'group.recovery.linked';
    const allowedTransitions: Readonly<Record<GroupExecutionStatus, readonly GroupExecutionStatus[]>> = {
      claimed: ['running', 'completed', 'failed', 'interrupted'],
      running: ['running', 'completed', 'failed', 'interrupted'],
      stop_requested: ['completed', 'failed', 'interrupted'],
      completed: [],
      failed: [],
      interrupted: [],
      abandoned: [],
    };
    if (!recoveryAbandon && !allowedTransitions[current.status].includes(input.status)) {
      throw new GroupInteractionRepositoryError(current.status === 'interrupted'
        ? 'EXECUTION_INTERRUPTED' : 'EXECUTION_STALE_OWNER');
    }
    this.db.prepare(`
      UPDATE cr_group_interaction_executions SET status = ?, terminal_reason = ?,
        current_agent_id = ?, current_turn_id = ?, current_message_id = ?, updated_at = ?
      WHERE workspace_id = ? AND interaction_id = ? AND owner_id = ? AND owner_epoch = ?
    `).run(
      input.status, input.terminalReason ?? null,
      input.currentAgentId === undefined ? current.currentAgentId : input.currentAgentId,
      input.currentTurnId === undefined ? current.currentTurnId : input.currentTurnId,
      input.currentMessageId === undefined ? current.currentMessageId : input.currentMessageId,
      input.updatedAt, input.workspaceId, input.interactionId, input.ownerId, input.ownerEpoch,
    );
    this.appendExecutionEventWithinTransaction({
      workspaceId: input.workspaceId,
      interactionId: input.interactionId,
      ownerId: input.ownerId,
      ownerEpoch: input.ownerEpoch,
      eventType: input.eventType,
      payload: input.payload,
      updatedAt: input.updatedAt,
    });
    return this.requireExecutionOwner(input.workspaceId, input.interactionId);
  }

  appendExecutionEventWithinTransaction(input: GroupExecutionEventInput): GroupExecutionEventRecord {
    this.assertOwner(input);
    const owner = this.requireExecutionOwner(input.workspaceId, input.interactionId);
    const terminalEvents: Readonly<Record<'completed' | 'failed', readonly string[]>> = {
      completed: ['group.done', 'group.reply.final', 'group.reply.rejected', 'group.stopped', 'group.turn.cancelled'],
      failed: ['group.turn.failed'],
    };
    if (owner.status === 'interrupted' && input.eventType !== 'group.interrupted') {
      throw new GroupInteractionRepositoryError('EXECUTION_INTERRUPTED');
    }
    if (owner.status === 'abandoned' && input.eventType !== 'group.recovery.linked') {
      throw new GroupInteractionRepositoryError('EXECUTION_STALE_OWNER');
    }
    if ((owner.status === 'completed' || owner.status === 'failed')
      && !terminalEvents[owner.status].includes(input.eventType)) {
      throw new GroupInteractionRepositoryError('EXECUTION_STALE_OWNER');
    }
    const interaction = this.requireInteraction(input.workspaceId, input.interactionId);
    const cursor = owner.eventCursor + 1;
    const payload = {
      ...(input.payload ?? {}),
      interactionId: input.interactionId,
      status: interaction.status,
      version: interaction.version,
      ownerEpoch: input.ownerEpoch,
    };
    this.db.prepare(`
      INSERT INTO cr_group_interaction_events (
        interaction_id, workspace_id, conversation_id, cursor, owner_epoch, event_type, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.interactionId, input.workspaceId, owner.conversationId, cursor, input.ownerEpoch,
      input.eventType, JSON.stringify(payload), input.updatedAt,
    );
    this.db.prepare(`
      UPDATE cr_group_interaction_executions SET event_cursor = ?, updated_at = ?
      WHERE workspace_id = ? AND interaction_id = ? AND owner_id = ? AND owner_epoch = ?
    `).run(cursor, input.updatedAt, input.workspaceId, input.interactionId, input.ownerId, input.ownerEpoch);
    return {
      interactionId: input.interactionId,
      workspaceId: input.workspaceId,
      conversationId: owner.conversationId,
      cursor,
      ownerEpoch: input.ownerEpoch,
      eventType: input.eventType,
      payload,
      createdAt: input.updatedAt,
    };
  }

  listExecutionEvents(workspaceId: string, conversationId: string, interactionId: string, afterCursor: number): GroupExecutionEventRecord[] {
    if (!nonBlank(workspaceId) || !nonBlank(conversationId) || !nonBlank(interactionId)
      || !Number.isSafeInteger(afterCursor) || afterCursor < 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM cr_group_interaction_events
      WHERE workspace_id = ? AND conversation_id = ? AND interaction_id = ? AND cursor > ?
      ORDER BY cursor ASC
    `).all(workspaceId, conversationId, interactionId, afterCursor) as EventRow[];
    return rows.map(toEventRecord);
  }

  requestStopWithinTransaction(input: RequestGroupStopInput): { interaction: GroupInteractionRecord; owner: GroupExecutionOwnerRecord | undefined } {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.interactionId) || !nonBlank(input.ownerId)
      || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !nonBlank(input.stoppedAt)) {
      throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    }
    const interaction = this.requireInteraction(input.workspaceId, input.interactionId);
    if (interaction.version !== input.expectedVersion) throw new GroupInteractionRepositoryError('GROUP_VERSION_CONFLICT');
    if (interaction.status !== 'active') throw new GroupInteractionRepositoryError('INTERACTION_NOT_TRANSITIONABLE');
    const updated = this.advanceInteractionWithinTransaction({
      workspaceId: input.workspaceId,
      interactionId: input.interactionId,
      expectedVersion: input.expectedVersion,
      replyIncrement: 0,
      hopIncrement: 0,
      status: 'stopped',
      stopReason: 'user-stop',
      endedAt: input.stoppedAt,
      updatedAt: input.stoppedAt,
    });
    const owner = this.findExecutionOwner(input.workspaceId, input.interactionId);
    if (owner === undefined) {
      this.db.prepare(`
        INSERT INTO cr_group_interaction_executions (
          interaction_id, workspace_id, conversation_id, source_message_id, owner_id,
          owner_epoch, participants_json, budget_json, status, terminal_reason, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'completed', 'user-stop', ?)
      `).run(
        updated.id, updated.workspaceId, updated.conversationId, updated.sourceMessageId,
        input.ownerId, input.ownerEpoch, JSON.stringify({
          maxAgentsPerTurn: updated.maxAgentsPerTurn,
          maxRepliesPerAgent: updated.maxRepliesPerAgent,
          maxTotalReplies: updated.maxTotalReplies,
          maxAgentHops: updated.maxAgentHops,
          timeoutMs: updated.timeoutMs,
          contextTokenBudget: updated.contextTokenBudget,
        }), input.stoppedAt,
      );
      this.appendExecutionEventWithinTransaction({
        workspaceId: input.workspaceId,
        interactionId: input.interactionId,
        ownerId: input.ownerId,
        ownerEpoch: input.ownerEpoch,
        eventType: 'group.stopped',
        payload: { stopReason: 'user-stop' },
        updatedAt: input.stoppedAt,
      });
      return { interaction: updated, owner: this.requireExecutionOwner(input.workspaceId, input.interactionId) };
    }
    if (owner.ownerId !== input.ownerId || owner.ownerEpoch !== input.ownerEpoch) {
      throw new GroupInteractionRepositoryError('EXECUTION_STALE_OWNER');
    }
    this.db.prepare(`
      UPDATE cr_group_interaction_executions SET status = 'stop_requested', terminal_reason = 'user-stop', updated_at = ?
      WHERE workspace_id = ? AND interaction_id = ? AND owner_id = ? AND owner_epoch = ?
        AND status IN ('claimed','running','stop_requested')
    `).run(input.stoppedAt, input.workspaceId, input.interactionId, input.ownerId, input.ownerEpoch);
    this.appendExecutionEventWithinTransaction({
      workspaceId: input.workspaceId,
      interactionId: input.interactionId,
      ownerId: input.ownerId,
      ownerEpoch: input.ownerEpoch,
      eventType: 'group.stop_requested',
      payload: { stopReason: 'user-stop' },
      updatedAt: input.stoppedAt,
    });
    return { interaction: updated, owner: this.requireExecutionOwner(input.workspaceId, input.interactionId) };
  }

  /** Mark uncertain post-restart owners interrupted. This API never replays work. */
  reconcileInterruptedOnStartup(updatedAt = new Date().toISOString()): number {
    if (!nonBlank(updatedAt)) throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    return inTransaction(this.db, () => {
      const rows = this.db.prepare(`
        SELECT workspace_id, interaction_id, owner_id, owner_epoch
        FROM cr_group_interaction_executions WHERE status IN ('claimed','running','stop_requested')
      `).all() as Array<{ workspace_id: string; interaction_id: string; owner_id: string; owner_epoch: number }>;
      for (const row of rows) {
        this.db.prepare(`
          UPDATE cr_group_interaction_executions SET status = 'interrupted',
            terminal_reason = 'server-restarted-owner-unknown', updated_at = ?
          WHERE workspace_id = ? AND interaction_id = ? AND owner_id = ? AND owner_epoch = ?
        `).run(updatedAt, row.workspace_id, row.interaction_id, row.owner_id, row.owner_epoch);
        this.db.prepare(`
          UPDATE cr_group_interactions SET integrity_status = 'unusable',
            integrity_reason = 'execution-owner-unknown-after-restart', version = version + 1, updated_at = ?
          WHERE workspace_id = ? AND id = ? AND status = 'active' AND integrity_status = 'valid'
        `).run(updatedAt, row.workspace_id, row.interaction_id);
        this.appendExecutionEventWithinTransaction({
          workspaceId: row.workspace_id,
          interactionId: row.interaction_id,
          ownerId: row.owner_id,
          ownerEpoch: row.owner_epoch,
          eventType: 'group.interrupted',
          payload: { reason: 'server-restarted-owner-unknown' },
          updatedAt,
        });
      }
      return rows.length;
    });
  }

  appendReplyWithinTransaction(input: AppendGroupReplyInput): GroupReplyRecord {
    if (!nonBlank(input.id) || !nonBlank(input.interactionId) || !nonBlank(input.agentId)
      || !nonBlank(input.messageId) || !nonBlank(input.contentHash) || !nonBlank(input.createdAt)
      || !Number.isSafeInteger(input.hopOrder) || input.hopOrder < 0
      || !nonBlank(input.turnId) || !nonBlank(input.ownerId)
      || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch! < 1) {
      throw new GroupInteractionRepositoryError('REPLY_INPUT_INVALID');
    }
    try {
      const association = this.db.prepare(`
        SELECT i.id AS interaction_id, i.workspace_id, i.conversation_id, i.source_message_id,
          i.integrity_status AS interaction_integrity,
          m.id AS message_id, m.workspace_id AS message_workspace_id, m.conversation_id AS message_conversation_id,
          m.sender_type AS message_sender_type, m.sender_agent_id AS message_sender_agent_id,
          m.status AS message_status, m.content AS message_content, m.reply_to_message_id AS message_reply_to_id,
          t.id AS turn_id, t.workspace_id AS turn_workspace_id, t.conversation_id AS turn_conversation_id,
          t.agent_id AS turn_agent_id, t.status AS turn_status, t.source_message_id AS turn_message_id,
          e.owner_id AS execution_owner_id, e.owner_epoch AS execution_owner_epoch,
          e.current_agent_id AS execution_current_agent_id, e.current_turn_id AS execution_current_turn_id,
          e.current_message_id AS execution_current_message_id, e.status AS execution_status
        FROM cr_group_interactions i
        JOIN cr_messages m ON m.id = ?
        JOIN cr_agent_turns t ON t.id = ?
        JOIN cr_group_interaction_executions e ON e.interaction_id = i.id
        WHERE i.id = ?
      `).get(input.messageId, input.turnId, input.interactionId) as ReplyAssociationRow | undefined;
      if (association === undefined
        || association.interaction_integrity !== 'valid'
        || association.source_message_id === null
        || association.message_workspace_id !== association.workspace_id
        || association.message_conversation_id !== association.conversation_id
        || association.message_sender_type !== 'agent'
        || association.message_sender_agent_id !== input.agentId
        || association.message_status !== 'final'
        || association.message_reply_to_id !== association.source_message_id
        || association.turn_workspace_id !== association.workspace_id
        || association.turn_conversation_id !== association.conversation_id
        || association.turn_agent_id !== input.agentId
        || association.turn_status !== 'final'
        || association.turn_message_id !== input.messageId
        || association.execution_owner_id !== input.ownerId
        || association.execution_owner_epoch !== input.ownerEpoch
        || association.execution_current_agent_id !== input.agentId
        || association.execution_current_turn_id !== input.turnId
        || association.execution_current_message_id !== input.messageId
        || (association.execution_status !== 'running' && association.execution_status !== 'stop_requested')
        || createHash('sha256').update(association.message_content).digest('hex') !== input.contentHash) {
        throw new GroupInteractionRepositoryError('GROUP_REPLY_ASSOCIATION_INVALID');
      }
      this.db.prepare(
        `INSERT INTO cr_group_interaction_replies (
          id, interaction_id, agent_id, message_id, turn_id, content_hash,
          mention_targets_json, hop_from_agent_id, hop_order, context_snapshot_id,
          owner_id, owner_epoch, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id, input.interactionId, input.agentId, input.messageId,
        input.turnId ?? null, input.contentHash, input.mentionTargetsJson ?? null,
        input.hopFromAgentId ?? null, input.hopOrder, input.contextSnapshotId ?? null,
        input.ownerId, input.ownerEpoch, input.createdAt,
      );
      const row = this.db.prepare('SELECT * FROM cr_group_interaction_replies WHERE id = ?')
        .get(input.id) as ReplyRow | undefined;
      if (row === undefined) throw new GroupInteractionRepositoryError('REPLY_PERSISTENCE_FAILED');
      return toReplyRecord(row);
    } catch (error) {
      if (error instanceof GroupInteractionRepositoryError) throw error;
      if (String(error).includes('GROUP_REPLY_ASSOCIATION_INVALID')) {
        throw new GroupInteractionRepositoryError('GROUP_REPLY_ASSOCIATION_INVALID');
      }
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

  findReplyByMessageId(interactionId: string, messageId: string): GroupReplyRecord | undefined {
    if (!nonBlank(interactionId) || !nonBlank(messageId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_group_interaction_replies WHERE interaction_id = ? AND message_id = ? LIMIT 1',
    ).get(interactionId, messageId) as ReplyRow | undefined;
    return row === undefined ? undefined : toReplyRecord(row);
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
      throw new GroupInteractionRepositoryError('GROUP_VERSION_CONFLICT');
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

  private assertActiveGroupSource(workspaceId: string, conversationId: string, sourceMessageId: string): void {
    const conversation = this.db.prepare(`
      SELECT kind, status FROM cr_conversations WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, conversationId) as { kind: string; status: string } | undefined;
    if (conversation === undefined) throw new GroupInteractionRepositoryError('INTERACTION_NOT_FOUND');
    if (conversation.kind !== 'group' || conversation.status !== 'active') {
      throw new GroupInteractionRepositoryError('CONVERSATION_NOT_ACTIVE_GROUP');
    }
    const source = this.db.prepare(`
      SELECT 1 AS present FROM cr_messages
      WHERE workspace_id = ? AND conversation_id = ? AND id = ?
        AND sender_type = 'user' AND status = 'final'
    `).get(workspaceId, conversationId, sourceMessageId);
    if (source === undefined) throw new GroupInteractionRepositoryError('INTERACTION_SOURCE_MISMATCH');
  }

  private assertNoOtherActiveInteraction(
    workspaceId: string,
    conversationId: string,
    exceptInteractionId?: string,
    recoverySupersedesInterrupted?: CreateGroupInteractionInput['recoverySupersedesInterrupted'],
  ): void {
    const active = this.db.prepare(`
      SELECT i.id, i.integrity_status, e.owner_id, e.owner_epoch, e.status AS owner_status,
        EXISTS (
          SELECT 1 FROM cr_group_interaction_events ev
          WHERE ev.workspace_id = i.workspace_id AND ev.interaction_id = i.id
            AND ev.owner_epoch = e.owner_epoch AND ev.event_type = 'group.recovery.linked'
        ) AS has_recovery_link
      FROM cr_group_interactions i
      LEFT JOIN cr_group_interaction_executions e
        ON e.workspace_id = i.workspace_id AND e.interaction_id = i.id
      WHERE i.workspace_id = ? AND i.conversation_id = ? AND i.status = 'active'
        AND (? IS NULL OR i.id <> ?)
    `).all(workspaceId, conversationId, exceptInteractionId ?? null, exceptInteractionId ?? null) as Array<{
      id: string;
      integrity_status: string;
      owner_id: string | null;
      owner_epoch: number | null;
      owner_status: string | null;
      has_recovery_link: number;
    }>;
    let recoveryPriorMatched = recoverySupersedesInterrupted === undefined;
    for (const row of active) {
      if (recoverySupersedesInterrupted?.interactionId === row.id) {
        if (row.integrity_status !== 'unusable' || row.owner_status !== 'interrupted'
          || row.owner_id !== recoverySupersedesInterrupted.ownerId
          || row.owner_epoch !== recoverySupersedesInterrupted.ownerEpoch) {
          throw new GroupInteractionRepositoryError('EXECUTION_INTERRUPTED');
        }
        recoveryPriorMatched = true;
        continue;
      }
      // A prior round stays visible and quarantined after a successful linked
      // recovery. It ceases to block only with its durable recovery event.
      if (row.integrity_status === 'unusable' && row.owner_status === 'abandoned'
        && row.has_recovery_link === 1) continue;
      throw new GroupInteractionRepositoryError('ACTIVE_INTERACTION_EXISTS');
    }
    if (!recoveryPriorMatched) throw new GroupInteractionRepositoryError('EXECUTION_INTERRUPTED');
  }

  private assertOwner(input: GroupExecutionOwnerInput): void {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.interactionId) || !nonBlank(input.ownerId)
      || !Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1 || !nonBlank(input.updatedAt)) {
      throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    }
    const owner = this.db.prepare(`
      SELECT owner_id, owner_epoch FROM cr_group_interaction_executions
      WHERE workspace_id = ? AND interaction_id = ?
    `).get(input.workspaceId, input.interactionId) as { owner_id: string; owner_epoch: number } | undefined;
    if (owner === undefined || owner.owner_id !== input.ownerId || owner.owner_epoch !== input.ownerEpoch) {
      throw new GroupInteractionRepositoryError('EXECUTION_STALE_OWNER');
    }
  }

  private requireExecutionOwner(workspaceId: string, interactionId: string): GroupExecutionOwnerRecord {
    const owner = this.findExecutionOwner(workspaceId, interactionId);
    if (owner === undefined) throw new GroupInteractionRepositoryError('INTERACTION_NOT_FOUND');
    return owner;
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
    sourceMessageId: row.source_message_id,
    integrityStatus: row.integrity_status === 'unusable' ? 'unusable' : 'valid',
    integrityReason: row.integrity_reason,
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
    ownerId: row.owner_id,
    ownerEpoch: row.owner_epoch,
    integrityStatus: row.integrity_status === 'unusable' ? 'unusable' : 'valid',
    integrityReason: row.integrity_reason,
    createdAt: row.created_at,
  };
}

function toExecutionRecord(row: ExecutionRow): GroupExecutionOwnerRecord {
  let participantAgentIds: string[] = [];
  let budget: Record<string, number | null> = {};
  try {
    const parsed: unknown = JSON.parse(row.participants_json);
    if (Array.isArray(parsed)) participantAgentIds = parsed.filter((id): id is string => typeof id === 'string');
  } catch { /* malformed persisted JSON fails closed as an empty participant list */ }
  try {
    const parsed: unknown = JSON.parse(row.budget_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      budget = parsed as Record<string, number | null>;
    }
  } catch { /* malformed persisted JSON is surfaced as an empty frozen budget */ }
  return {
    interactionId: row.interaction_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    ownerId: row.owner_id,
    ownerEpoch: row.owner_epoch,
    participantAgentIds,
    budget,
    status: row.status as GroupExecutionStatus,
    currentAgentId: row.current_agent_id,
    currentTurnId: row.current_turn_id,
    currentMessageId: row.current_message_id,
    eventCursor: row.event_cursor,
    terminalReason: row.terminal_reason,
    updatedAt: row.updated_at,
  };
}

function toEventRecord(row: EventRow): GroupExecutionEventRecord {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* JSON validity is also enforced by the database constraint */ }
  return {
    interactionId: row.interaction_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    cursor: row.cursor,
    ownerEpoch: row.owner_epoch,
    eventType: row.event_type,
    payload,
    createdAt: row.created_at,
  };
}
