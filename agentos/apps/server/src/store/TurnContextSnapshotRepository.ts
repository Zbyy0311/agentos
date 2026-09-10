import type { TransactionDatabase } from './Transaction.js';

/**
 * CR-5 Turn-scoped per-Agent Memory Context snapshot persistence.
 *
 * Frozen design: docs/implementation/milestones/CR5-schema-authorization.md section 3.
 * A Turn-scoped snapshot records what ONE Agent Turn received from Memory selection,
 * keyed by (conversation, interaction, agent, turn) — never by Run, because a
 * chat-only group Turn has no Run and migration 018's snapshot store is Run-scoped.
 * Write-once: a snapshot is never edited; a correction appends a new snapshot.
 * No secret value is stored (selected Entry identities and budget metadata only).
 */

export interface InsertTurnContextSnapshotInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly interactionId?: string;
  readonly agentId: string;
  readonly turnId?: string;
  readonly budgetJson: string;
  readonly selectedEntryIdsJson: string;
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly queryHash?: string;
  readonly retrievalStrategyVersion: string;
  readonly createdAt: string;
}

export interface TurnContextSnapshotRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly interactionId: string | null;
  readonly agentId: string;
  readonly turnId: string | null;
  readonly budgetJson: string;
  readonly selectedEntryIdsJson: string;
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly queryHash: string | null;
  readonly retrievalStrategyVersion: string;
  readonly createdAt: string;
}

export type TurnContextSnapshotRepositoryErrorCode =
  | 'SNAPSHOT_INPUT_INVALID'
  | 'SNAPSHOT_PERSISTENCE_FAILED';

export class TurnContextSnapshotRepositoryError extends Error {
  constructor(readonly code: TurnContextSnapshotRepositoryErrorCode) {
    super(`TURN_CONTEXT_SNAPSHOT_${code}`);
    this.name = 'TurnContextSnapshotRepositoryError';
  }
}

interface SnapshotRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  interaction_id: string | null;
  agent_id: string;
  turn_id: string | null;
  budget_json: string;
  selected_entry_ids_json: string;
  total_tokens: number;
  truncated: number;
  query_hash: string | null;
  retrieval_strategy_version: string;
  created_at: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isJsonArrayOfStrings(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string');
  } catch {
    return false;
  }
}

export class TurnContextSnapshotRepository {
  constructor(private readonly db: TransactionDatabase) {}

  insertWithinTransaction(input: InsertTurnContextSnapshotInput): TurnContextSnapshotRecord {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.conversationId)
      || !nonBlank(input.agentId) || !nonBlank(input.budgetJson)
      || !isJsonArrayOfStrings(input.selectedEntryIdsJson)
      || !Number.isSafeInteger(input.totalTokens) || input.totalTokens < 0
      || !nonBlank(input.retrievalStrategyVersion) || !nonBlank(input.createdAt)) {
      throw new TurnContextSnapshotRepositoryError('SNAPSHOT_INPUT_INVALID');
    }
    try {
      this.db.prepare(
        `INSERT INTO cr_turn_context_snapshots (
          id, workspace_id, conversation_id, interaction_id, agent_id, turn_id,
          budget_json, selected_entry_ids_json, total_tokens, truncated, query_hash,
          retrieval_strategy_version, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id, input.workspaceId, input.conversationId, input.interactionId ?? null,
        input.agentId, input.turnId ?? null, input.budgetJson, input.selectedEntryIdsJson,
        input.totalTokens, input.truncated ? 1 : 0, input.queryHash ?? null,
        input.retrievalStrategyVersion, input.createdAt,
      );
    } catch (error) {
      if (error instanceof TurnContextSnapshotRepositoryError) throw error;
      throw new TurnContextSnapshotRepositoryError('SNAPSHOT_PERSISTENCE_FAILED');
    }
    const row = this.db.prepare('SELECT * FROM cr_turn_context_snapshots WHERE id = ?')
      .get(input.id) as SnapshotRow | undefined;
    if (row === undefined) throw new TurnContextSnapshotRepositoryError('SNAPSHOT_PERSISTENCE_FAILED');
    return toSnapshotRecord(row);
  }

  findById(workspaceId: string, snapshotId: string): TurnContextSnapshotRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(snapshotId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_turn_context_snapshots WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, snapshotId) as SnapshotRow | undefined;
    return row === undefined ? undefined : toSnapshotRecord(row);
  }

  /** Latest snapshot for one Agent in one Conversation (isolation read). */
  findLatestForAgent(conversationId: string, agentId: string): TurnContextSnapshotRecord | undefined {
    if (!nonBlank(conversationId) || !nonBlank(agentId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_turn_context_snapshots WHERE conversation_id = ? AND agent_id = ? ORDER BY created_at DESC, id ASC LIMIT 1',
    ).get(conversationId, agentId) as SnapshotRow | undefined;
    return row === undefined ? undefined : toSnapshotRecord(row);
  }

  listByInteraction(interactionId: string): TurnContextSnapshotRecord[] {
    if (!nonBlank(interactionId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_turn_context_snapshots WHERE interaction_id = ? ORDER BY created_at ASC, id ASC',
    ).all(interactionId) as SnapshotRow[];
    return rows.map(toSnapshotRecord);
  }
}

function toSnapshotRecord(row: SnapshotRow): TurnContextSnapshotRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    interactionId: row.interaction_id,
    agentId: row.agent_id,
    turnId: row.turn_id,
    budgetJson: row.budget_json,
    selectedEntryIdsJson: row.selected_entry_ids_json,
    totalTokens: row.total_tokens,
    truncated: row.truncated === 1,
    queryHash: row.query_hash,
    retrievalStrategyVersion: row.retrieval_strategy_version,
    createdAt: row.created_at,
  };
}

