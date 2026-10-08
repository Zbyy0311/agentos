/**
 * CR-0 Conversation Runtime contracts.
 *
 * Freezes the shared/domain contracts required by later Conversation Runtime
 * slices WITHOUT activating the forward Conversation persistence, streaming,
 * projection, or UI. It contains only pure types and deterministic validators.
 *
 * Authority: `docs/Runtime-Specification lite/09-Conversation-Runtime.md`.
 * Entry audit: `docs/implementation/milestones/CR-entry-audit.md`.
 *
 * Explicitly out of scope for CR-0 (deferred to later slices):
 *   - any Conversation migration or table/column change (migration 020);
 *   - any repository, service, route, stream, or projection wiring;
 *   - any UI or Inspector surface;
 *   - any change to the legacy `agent_runs` conversation path.
 *
 * The baseline `ConversationType` (`direct | group`) is retained under
 * COMPATIBILITY; the forward type adds `system`.
 */

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/** Forward Conversation kinds. `system` is new; `direct`/`group` are retained. */
export const CONVERSATION_KINDS = ['direct', 'group', 'system'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const CONVERSATION_STATUSES = ['active', 'archived'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/** Order and concurrency of eligible Agents for one interaction. */
export const CONVERSATION_REPLY_MODES = [
  'sequential',
  'parallel-read-only',
  'orchestrated',
  'manual',
  'mention-only',
] as const;
export type ConversationReplyMode = (typeof CONVERSATION_REPLY_MODES)[number];

// ---------------------------------------------------------------------------
// Member
// ---------------------------------------------------------------------------

export const MEMBER_SUBJECT_TYPES = ['user', 'agent'] as const;
export type MemberSubjectType = (typeof MEMBER_SUBJECT_TYPES)[number];

/** Forward member roles. Distinct from the legacy `CollaborationRole`. */
export const MEMBER_ROLES = [
  'owner',
  'participant',
  'observer',
  'orchestrator',
  'reviewer',
] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Whether a member replies by default. Member reply mode determines
 * eligibility; the Conversation reply mode then determines order/concurrency.
 */
export const MEMBER_REPLY_MODES = [
  'always',
  'mentioned',
  'orchestrated',
  'manual',
  'never',
] as const;
export type MemberReplyMode = (typeof MEMBER_REPLY_MODES)[number];

export const MEMBER_STATUSES = ['active', 'muted', 'removed'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const MESSAGE_KINDS = [
  'text',
  'task-reference',
  'run-reference',
  'status',
  'approval',
  'artifact',
  'error',
  'system-notice',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Message lifecycle. `edited` and `deleted` are terminal-ish states. */
export const MESSAGE_STATUSES = [
  'draft',
  'streaming',
  'final',
  'failed',
  'edited',
  'deleted',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** A Message whose content may still change; these are not yet durable facts. */
export const MESSAGE_NON_FINAL_STATUSES = [
  'draft',
  'streaming',
] as const satisfies readonly MessageStatus[];

export function isMessageFinal(status: MessageStatus): boolean {
  return status === 'final' || status === 'edited';
}

/**
 * CR-3 frozen Message status transitions. The durable streaming contract only
 * needs reservation (draft/streaming) and one-way finalization (final, failed,
 * deleted); every other transition stays rejected until a later slice freezes it.
 */
export const MESSAGE_STATUS_TRANSITIONS = {
  draft: ['streaming', 'failed', 'deleted'],
  streaming: ['final', 'failed', 'deleted'],
  final: [],
  failed: [],
  edited: [],
  deleted: [],
} as const satisfies Record<MessageStatus, readonly MessageStatus[]>;

export function canTransitionMessage(from: MessageStatus, to: MessageStatus): boolean {
  return (MESSAGE_STATUS_TRANSITIONS[from] as readonly MessageStatus[]).includes(to);
}

// ---------------------------------------------------------------------------
// Agent Turn
// ---------------------------------------------------------------------------

export const AGENT_TURN_STATUSES = [
  'created',
  'streaming',
  'final',
  'failed',
  'cancelled',
] as const;
export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number];

/** Terminal Turn statuses. */
export const AGENT_TURN_TERMINAL_STATUSES = [
  'final',
  'failed',
  'cancelled',
] as const satisfies readonly AgentTurnStatus[];

export function isAgentTurnTerminal(status: AgentTurnStatus): boolean {
  return (AGENT_TURN_TERMINAL_STATUSES as readonly AgentTurnStatus[]).includes(status);
}

// ---------------------------------------------------------------------------
// Streaming checkpoints
// ---------------------------------------------------------------------------

export interface MessageStreamCheckpointV1 {
  readonly messageId: string;
  readonly turnId: string;
  /** Monotonic checkpoint ordinal starting at 1 within one Message. */
  readonly ordinal: number;
  /** Durable cursor the client uses to resume without gaps. */
  readonly cursor: number;
  readonly delta: string;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Client idempotency
// ---------------------------------------------------------------------------

/**
 * A repeated send with the same `clientMessageId` converges on ONE Message.
 * The key is scoped to the Conversation.
 */
export interface ClientMessageKeyV1 {
  readonly conversationId: string;
  readonly clientMessageId: string;
}

export function clientMessageKeyId(key: ClientMessageKeyV1): string {
  return key.conversationId + '|' + key.clientMessageId;
}

// ---------------------------------------------------------------------------
// Bounded group interaction
// ---------------------------------------------------------------------------

export interface GroupInteractionBudgetV1 {
  /** Maximum distinct Agents that may reply in one interaction. */
  readonly maxAgentsPerTurn: number;
  /** Maximum replies from any single Agent. */
  readonly maxRepliesPerAgent: number;
  /** Maximum total replies across all Agents. */
  readonly maxTotalReplies: number;
  /** Maximum Agent-to-Agent hops. */
  readonly maxAgentHops: number;
  /** Optional overall timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional context token budget per Agent. */
  readonly contextTokenBudget?: number;
}

export type GroupBudgetError =
  | 'NOT_OBJECT'
  | 'LIMIT_INVALID'
  | 'HOPS_INVALID'
  | 'TIMEOUT_INVALID'
  | 'CONTEXT_BUDGET_INVALID'
  | 'AGENT_LIMIT_EXCEEDS_TOTAL';

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Fail-closed validation for untyped callers. */
export function validateGroupInteractionBudget(input: unknown): {
  readonly valid: boolean;
  readonly reason?: GroupBudgetError;
} {
  if (typeof input !== 'object' || input === null) return { valid: false, reason: 'NOT_OBJECT' };
  const budget = input as Record<string, unknown>;
  for (const key of ['maxAgentsPerTurn', 'maxRepliesPerAgent', 'maxTotalReplies'] as const) {
    if (!isPositiveSafeInteger(budget[key])) return { valid: false, reason: 'LIMIT_INVALID' };
  }
  if (!isNonNegativeSafeInteger(budget.maxAgentHops)) return { valid: false, reason: 'HOPS_INVALID' };
  if (budget.timeoutMs !== undefined && !isPositiveSafeInteger(budget.timeoutMs)) {
    return { valid: false, reason: 'TIMEOUT_INVALID' };
  }
  if (budget.contextTokenBudget !== undefined && !isPositiveSafeInteger(budget.contextTokenBudget)) {
    return { valid: false, reason: 'CONTEXT_BUDGET_INVALID' };
  }
  if ((budget.maxAgentsPerTurn as number) > (budget.maxTotalReplies as number)) {
    return { valid: false, reason: 'AGENT_LIMIT_EXCEEDS_TOTAL' };
  }
  return { valid: true };
}

/** Stable reason a bounded group interaction ended. */
export const GROUP_STOP_REASONS = [
  'budget-agents',
  'budget-replies-per-agent',
  'budget-total-replies',
  'budget-hops',
  'budget-timeout',
  'user-stop',
  'loop-guard',
  'completed',
] as const;
export type GroupStopReason = (typeof GROUP_STOP_REASONS)[number];

/** Loop-guard signals that terminate a group interaction. */
export const LOOP_GUARD_SIGNALS = [
  'same-agent-cycle',
  'repeated-content',
  'repeated-mention-no-new-information',
  'hops-exceeded',
] as const;
export type LoopGuardSignal = (typeof LOOP_GUARD_SIGNALS)[number];

// ---------------------------------------------------------------------------
// Event projection
// ---------------------------------------------------------------------------

/**
 * Idempotent Event projection key. One Runtime Event produces at most one
 * Conversation card per projector.
 */
export interface ConversationProjectionKeyV1 {
  readonly projectorId: string;
  readonly sourceEventId: string;
}

export function projectionKeyId(key: ConversationProjectionKeyV1): string {
  return key.projectorId + '|' + key.sourceEventId;
}

/**
 * Frozen CR-4b projector identity. The projection key column is generalized, so a
 * later projector must claim its own id instead of colliding with this one.
 */
export const DEFAULT_CONVERSATION_PROJECTOR_ID = 'conversation.event-card.v1' as const;

/**
 * Frozen boundary rules: a normal Message never creates a Task or Run, and an
 * Event projection creates a Message card without turning the Message into an
 * Event.
 */
export const CONVERSATION_BOUNDARY_RULES = Object.freeze({
  normalMessageCreatesTask: false,
  normalMessageStartsRun: false,
  projectionBecomesRuntimeEvent: false,
  archiveCascadesDeletes: false,
  browserDisconnectCancelsRun: false,
} as const);

// ---------------------------------------------------------------------------
// Archive / restore
// ---------------------------------------------------------------------------

export type ConversationLifecycleAction = 'archive' | 'restore';

/**
 * Archive blocks new Turns but never cancels a Run or deletes Messages, Tasks,
 * Runs, Memory, Artifacts, or Events. Restore does not replay or resume Turns.
 */
export function canTransitionConversation(
  from: ConversationStatus,
  action: ConversationLifecycleAction,
): boolean {
  if (action === 'archive') return from === 'active';
  return from === 'archived';
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

/** `@all` targets active reply-capable members; it never authorizes parallel modification. */
export const MENTION_ALL = '@all' as const;

export interface MentionTargetV1 {
  readonly kind: 'agent' | 'all';
  /** Present only when kind === 'agent'. */
  readonly agentId?: string;
}

export function validateMentionTarget(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false;
  const target = input as Record<string, unknown>;
  if (target.kind === 'all') return Object.keys(target).length === 1;
  if (target.kind !== 'agent') return false;
  return Object.keys(target).length === 2
    && typeof target.agentId === 'string'
    && target.agentId.trim().length > 0;
}
