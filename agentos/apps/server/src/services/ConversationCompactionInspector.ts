import type { TransactionDatabase } from '../store/Transaction.js';
import {
  CompactionPolicyRepository,
  CompactionRepository,
  type CompactionTaskRecord,
} from '../store/CompactionRepository.js';

/**
 * LITE-13-101: the read-only compaction explanation.
 *
 * One read model serves both surfaces - the Conversation-scoped view and the
 * Run-scoped Runtime Inspector - so the two can never drift into telling
 * different stories about the same compaction. Every field is read back from a
 * durable row; nothing is inferred, recomputed or fabricated. A Conversation
 * that never compacted yields an explanation with no tasks instead of a
 * synthesised one, and the Run link records HOW the Conversation was resolved
 * so a reader can tell a Turn-backed link from a weaker one.
 */

export interface CompactionInspectorPolicy {
  readonly id: string;
  readonly policyVersion: string;
  readonly triggerRatio: number;
  readonly targetRatio: number;
  readonly minRecentMessages: number;
  readonly summaryMaxTokens: number;
  readonly timeoutMs: number;
  readonly maxAutomaticRetries: number;
  readonly fallbackApplicationBudgetTokens: number;
  readonly parameters: Record<string, unknown>;
}

export interface CompactionInspectorTask {
  readonly id: string;
  readonly status: string;
  readonly policyId: string;
  readonly sourceStartMessageId: string | null;
  readonly sourceEndMessageId: string | null;
  readonly sourceMessageCount: number;
  readonly sourceHash: string;
  readonly priorSummaryId: string | null;
  readonly summary: string | null;
  readonly summaryHash: string | null;
  readonly summaryTokenEstimate: number | null;
  readonly candidateId: string | null;
  readonly providerConfigId: string | null;
  readonly providerType: string | null;
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  readonly model: string | null;
  readonly estimatorVersion: string;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly publishedAt: string | null;
  /** The frozen budget inputs of THIS evaluation: thresholds, composition, source size. */
  readonly budget: Record<string, unknown>;
}

/** A Turn Context Snapshot that actually received a published summary. */
export interface CompactionInspectorAdoption {
  readonly snapshotId: string;
  readonly turnId: string | null;
  readonly summaryId: string;
  readonly summarizedMessages: number | null;
  readonly createdAt: string;
}

/**
 * A Turn Context Snapshot that refused a summary, with the durable reason.
 * Refusal is part of the explanation: why a Conversation is not compressed
 * right now has to be answerable too.
 */
export interface CompactionInspectorRejection {
  readonly snapshotId: string;
  readonly turnId: string | null;
  readonly summaryId: string;
  readonly reason: string;
  readonly createdAt: string;
}

export interface ConversationCompactionExplanation {
  readonly conversationId: string;
  readonly tasks: readonly CompactionInspectorTask[];
  readonly policies: readonly CompactionInspectorPolicy[];
  readonly adoptions: readonly CompactionInspectorAdoption[];
  readonly rejections: readonly CompactionInspectorRejection[];
}

export type RunConversationLinkVia = 'turn' | 'message' | 'task';

export interface RunConversationLink {
  readonly conversationId: string;
  /** The Turn that carried this Run, when the link came from the Turn table. */
  readonly turnId: string | null;
  /** The frozen Context Snapshot of that Turn, when one is recorded. */
  readonly contextSnapshotId: string | null;
  readonly via: RunConversationLinkVia;
}

interface SnapshotBudgetRow {
  id: string;
  turn_id: string | null;
  created_at: string;
  budget_json: string;
}

function parseBudget(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    // A malformed budget row is reported as absent rather than guessed at; the
    // consuming surface shows the task without a budget composition.
    return undefined;
  }
}

function toTaskView(task: CompactionTaskRecord): CompactionInspectorTask {
  return {
    id: task.id,
    status: task.status,
    policyId: task.policyId,
    sourceStartMessageId: task.sourceStartMessageId,
    sourceEndMessageId: task.sourceEndMessageId,
    sourceMessageCount: task.sourceMessageCount,
    sourceHash: task.sourceHash,
    priorSummaryId: task.priorSummaryId,
    summary: task.summary,
    summaryHash: task.summaryHash,
    summaryTokenEstimate: task.summaryTokenEstimate,
    candidateId: task.candidateId,
    providerConfigId: task.providerConfigId,
    providerType: task.providerType,
    adapterId: task.adapterId,
    adapterVersion: task.adapterVersion,
    model: task.model,
    estimatorVersion: task.estimatorVersion,
    attempts: task.attempts,
    leaseOwner: task.leaseOwner,
    leaseExpiresAt: task.leaseExpiresAt,
    failureCode: task.failureCode,
    failureMessage: task.failureMessage,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    publishedAt: task.publishedAt,
    budget: parseBudget(task.budgetJson) ?? {},
  };
}

function readSnapshotVerdicts(db: TransactionDatabase, conversationId: string): {
  adoptions: CompactionInspectorAdoption[];
  rejections: CompactionInspectorRejection[];
} {
  const rows = db.prepare(
    'SELECT id, turn_id, created_at, budget_json FROM cr_turn_context_snapshots WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
  ).all(conversationId) as SnapshotBudgetRow[];
  const adoptions: CompactionInspectorAdoption[] = [];
  const rejections: CompactionInspectorRejection[] = [];
  for (const row of rows) {
    const budget = parseBudget(row.budget_json);
    if (budget === undefined) continue;
    const applied = budget.compactionSummaryId;
    if (typeof applied === 'string') {
      adoptions.push({
        snapshotId: row.id,
        turnId: row.turn_id,
        summaryId: applied,
        summarizedMessages: typeof budget.summarizedMessages === 'number' ? budget.summarizedMessages : null,
        createdAt: row.created_at,
      });
    }
    const rejected = budget.rejectedCompactionSummaryId;
    if (typeof rejected === 'string') {
      rejections.push({
        snapshotId: row.id,
        turnId: row.turn_id,
        summaryId: rejected,
        reason: typeof budget.rejectedCompactionReason === 'string' ? budget.rejectedCompactionReason : 'unknown',
        createdAt: row.created_at,
      });
    }
  }
  return { adoptions, rejections };
}

/**
 * The full compaction explanation for one Conversation: every durable task,
 * the immutable policy each task ran under, and the Turns/Snapshots that
 * adopted or refused a published summary.
 */
export function projectConversationCompaction(
  db: TransactionDatabase,
  workspaceId: string,
  conversationId: string,
): ConversationCompactionExplanation {
  const tasks = new CompactionRepository(db).listForConversation(workspaceId, conversationId);
  const taskViews = tasks.map(toTaskView);
  const policies: CompactionInspectorPolicy[] = [];
  const policyRepository = new CompactionPolicyRepository(db);
  for (const policyId of new Set(tasks.map(task => task.policyId))) {
    const policy = policyRepository.findById(policyId);
    if (policy === undefined) continue;
    policies.push({
      id: policy.id,
      policyVersion: policy.policyVersion,
      triggerRatio: policy.triggerRatio,
      targetRatio: policy.targetRatio,
      minRecentMessages: policy.minRecentMessages,
      summaryMaxTokens: policy.summaryMaxTokens,
      timeoutMs: policy.timeoutMs,
      maxAutomaticRetries: policy.maxAutomaticRetries,
      fallbackApplicationBudgetTokens: policy.fallbackApplicationBudgetTokens,
      parameters: parseBudget(policy.parametersJson) ?? {},
    });
  }
  const verdicts = readSnapshotVerdicts(db, conversationId);
  return {
    conversationId,
    tasks: taskViews,
    policies,
    adoptions: verdicts.adoptions,
    rejections: verdicts.rejections,
  };
}

/**
 * Resolves the Conversation a Run belongs to without guessing.
 *
 * Three durable relations exist, and they are not equally strong, so the link
 * reports which one it used: the Turn that carried the Run (the only one that
 * also names the frozen Context Snapshot), then a Message bound to the Run, then
 * the Task source Conversation. A Run that no relation can place resolves to
 * nothing, and the caller must then report that it could not be placed rather
 * than an empty compaction story.
 */
export function resolveRunConversation(
  db: TransactionDatabase,
  workspaceId: string,
  runId: string,
): RunConversationLink | undefined {
  const turn = db.prepare(
    'SELECT id, conversation_id, context_snapshot_id FROM cr_agent_turns WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
  ).get(workspaceId, runId) as { id: string; conversation_id: string; context_snapshot_id: string | null } | undefined;
  if (turn !== undefined) {
    return {
      conversationId: turn.conversation_id,
      turnId: turn.id,
      contextSnapshotId: turn.context_snapshot_id,
      via: 'turn',
    };
  }
  const message = db.prepare(
    'SELECT conversation_id FROM cr_messages WHERE workspace_id = ? AND run_id = ? ORDER BY sequence ASC, id ASC LIMIT 1',
  ).get(workspaceId, runId) as { conversation_id: string } | undefined;
  if (message !== undefined) {
    return { conversationId: message.conversation_id, turnId: null, contextSnapshotId: null, via: 'message' };
  }
  const task = db.prepare(
    'SELECT t.source_conversation_id AS conversationId FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.workspace_id = ? AND r.id = ? AND t.source_conversation_id IS NOT NULL',
  ).get(workspaceId, runId) as { conversationId: string } | undefined;
  if (task !== undefined) {
    return { conversationId: task.conversationId, turnId: null, contextSnapshotId: null, via: 'task' };
  }
  return undefined;
}
