import type {
  MemoryExclusionReasonCode,
  MemorySelectionExplanationV1,
  MemorySelectionReasonCode,
} from '@agentos/shared';
import { createHash } from 'node:crypto';
import { isMemoryTextSafe } from './MemoryContentSafety.js';
import type { TransactionDatabase } from './Transaction.js';

export interface TurnContextMemoryExclusion {
  readonly memoryId: string;
  readonly memoryVersion: number;
  readonly rank: number;
  readonly reason: MemoryExclusionReasonCode;
  /** MF-3 ranking reasons plus the budget exclusion reason. */
  readonly reasons: readonly (MemorySelectionReasonCode | MemoryExclusionReasonCode)[];
}

export interface InsertTurnContextMemoryPayloadInput {
  readonly contextText: string;
  readonly selected: readonly MemorySelectionExplanationV1[];
  readonly exclusions: readonly TurnContextMemoryExclusion[];
  readonly retrievalDegraded: boolean;
}

/** DTO shared with the canonical unified read API. Historical snapshots have no DTO. */
export interface TurnContextMemoryPayloadRecord {
  readonly snapshotId: string;
  readonly contextText: string;
  readonly contextSha256: string;
  readonly queryHash: string | null;
  readonly selected: readonly MemorySelectionExplanationV1[];
  readonly exclusions: readonly TurnContextMemoryExclusion[];
  readonly retrievalDegraded: boolean;
}

/**
 * CR-5 Turn-scoped per-Agent Memory Context snapshot persistence.
 *
 * Frozen design: docs/implementation/milestones/CR5-schema-authorization.md section 3.
 * A Turn-scoped snapshot records what ONE Agent Turn received from Memory selection,
 * keyed by (conversation, interaction, agent, turn) — never by Run, because a
 * chat-only group Turn has no Run and migration 018's snapshot store is Run-scoped.
 * Write-once: a snapshot is never edited; a correction appends a new snapshot.
 * New snapshots also freeze safe injected text and versioned explanations;
 * historical metadata-only snapshots remain unchanged.
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
  /** Omitted only by legacy metadata-only callers; new Turn writes include it. */
  readonly memoryPayload?: InsertTurnContextMemoryPayloadInput;
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

interface MemoryPayloadRow {
  snapshot_id: string;
  context_text: string;
  context_sha256: string;
  selection_json: string;
  exclusions_json: string;
  retrieval_degraded: number;
  query_hash: string | null;
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
    if (input.memoryPayload !== undefined) {
      this.insertMemoryPayloadWithinTransaction(input.id, input.memoryPayload);
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

  /** All snapshots attached to one canonical Agent Turn, Workspace-scoped. */
  listForTurn(workspaceId: string, turnId: string): TurnContextSnapshotRecord[] {
    if (!nonBlank(workspaceId) || !nonBlank(turnId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_turn_context_snapshots WHERE workspace_id = ? AND turn_id = ? ORDER BY created_at ASC, id ASC',
    ).all(workspaceId, turnId) as SnapshotRow[];
    return rows.map(toSnapshotRecord);
  }

  /** Bounded Workspace inspection for callers that need to enumerate Turn snapshots. */
  listForWorkspace(workspaceId: string, limit = 200): TurnContextSnapshotRecord[] {
    if (!nonBlank(workspaceId) || !Number.isSafeInteger(limit) || limit < 1) return [];
    const boundedLimit = Math.min(limit, 1000);
    const rows = this.db.prepare(
      'SELECT * FROM cr_turn_context_snapshots WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    ).all(workspaceId, boundedLimit) as SnapshotRow[];
    return rows.map(toSnapshotRecord);
  }

  /**
   * Read the exact immutable text and explanations a Turn froze. The query itself
   * is never stored; only its hash from the canonical snapshot header is returned.
   * A missing row means a historical IDs-only snapshot and is intentionally not
   * backfilled.
   */
  readPayload(workspaceId: string, snapshotId: string): TurnContextMemoryPayloadRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(snapshotId)) return undefined;
    const row = this.db.prepare(
      `SELECT p.*, s.query_hash FROM cr_turn_memory_payloads p
       JOIN cr_turn_context_snapshots s ON s.id = p.snapshot_id
       WHERE s.workspace_id = ? AND s.id = ?`,
    ).get(workspaceId, snapshotId) as MemoryPayloadRow | undefined;
    if (row === undefined) return undefined;

    let selected: unknown;
    let exclusions: unknown;
    try {
      selected = JSON.parse(row.selection_json);
      exclusions = JSON.parse(row.exclusions_json);
    } catch {
      throw new TurnContextSnapshotRepositoryError('SNAPSHOT_PERSISTENCE_FAILED');
    }
    if (!Array.isArray(selected) || !selected.every(isSelectionExplanation)
      || !Array.isArray(exclusions) || !exclusions.every(isExclusionExplanation)
      || typeof row.context_text !== 'string'
      || createHash('sha256').update(row.context_text).digest('hex') !== row.context_sha256
      || !isMemoryTextSafe(row.context_text)
      || !isMemoryTextSafe(row.selection_json)
      || !isMemoryTextSafe(row.exclusions_json)) {
      throw new TurnContextSnapshotRepositoryError('SNAPSHOT_PERSISTENCE_FAILED');
    }
    return {
      snapshotId: row.snapshot_id,
      contextText: row.context_text,
      contextSha256: row.context_sha256,
      queryHash: row.query_hash,
      selected: selected as MemorySelectionExplanationV1[],
      exclusions: exclusions as TurnContextMemoryExclusion[],
      retrievalDegraded: row.retrieval_degraded === 1,
    };
  }

  private insertMemoryPayloadWithinTransaction(
    snapshotId: string,
    payload: InsertTurnContextMemoryPayloadInput,
  ): void {
    if (typeof payload.contextText !== 'string' || !Array.isArray(payload.selected)
      || !payload.selected.every(isSelectionExplanation)
      || !Array.isArray(payload.exclusions) || !payload.exclusions.every(isExclusionExplanation)
      || typeof payload.retrievalDegraded !== 'boolean') {
      throw new TurnContextSnapshotRepositoryError('SNAPSHOT_INPUT_INVALID');
    }
    let selectionJson: string;
    let exclusionsJson: string;
    try {
      selectionJson = JSON.stringify(payload.selected);
      exclusionsJson = JSON.stringify(payload.exclusions);
    } catch {
      throw new TurnContextSnapshotRepositoryError('SNAPSHOT_INPUT_INVALID');
    }
    if (!isMemoryTextSafe(payload.contextText) || !isMemoryTextSafe(selectionJson)
      || !isMemoryTextSafe(exclusionsJson)) {
      throw new TurnContextSnapshotRepositoryError('SNAPSHOT_INPUT_INVALID');
    }
    try {
      this.db.prepare(
        `INSERT INTO cr_turn_memory_payloads (
          snapshot_id, context_text, context_sha256, selection_json, exclusions_json, retrieval_degraded
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        snapshotId,
        payload.contextText,
        createHash('sha256').update(payload.contextText).digest('hex'),
        selectionJson,
        exclusionsJson,
        payload.retrievalDegraded ? 1 : 0,
      );
    } catch (error) {
      if (error instanceof TurnContextSnapshotRepositoryError) throw error;
      throw new TurnContextSnapshotRepositoryError('SNAPSHOT_PERSISTENCE_FAILED');
    }
  }
}

function isSelectionExplanation(value: unknown): value is MemorySelectionExplanationV1 {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<MemorySelectionExplanationV1>;
  return nonBlank(item.memoryId) && Number.isSafeInteger(item.memoryVersion) && (item.memoryVersion ?? 0) >= 1
    && Number.isSafeInteger(item.rank) && (item.rank ?? 0) >= 1
    && Array.isArray(item.reasons) && item.reasons.length > 0 && item.reasons.every(nonBlank);
}

function isExclusionExplanation(value: unknown): value is TurnContextMemoryExclusion {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<TurnContextMemoryExclusion>;
  return nonBlank(item.memoryId) && Number.isSafeInteger(item.memoryVersion) && (item.memoryVersion ?? 0) >= 1
    && Number.isSafeInteger(item.rank) && (item.rank ?? 0) >= 1
    && nonBlank(item.reason) && Array.isArray(item.reasons) && item.reasons.length > 0
    && item.reasons.every(nonBlank);
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

