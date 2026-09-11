import type {
  MemoryBudgetPolicyV1,
  MemorySelectionExplanationV1,
  MemoryExclusionExplanationV1,
} from '@agentos/shared';
import { inTransaction, type TransactionDatabase } from './Transaction.js';

/**
 * MF-4 Memory Context Snapshot persistence primitive.
 *
 * Write-once: a snapshot records exactly what one Run or Stage received. Later
 * Entry edits never rewrite it; corrections append a new snapshot. This module
 * performs no budget selection and no Provider injection; those belong to the
 * budget selector and a later integration slice.
 *
 * Frozen design: `docs/implementation/milestones/MF4-schema-authorization.md`.
 */

export type MemoryContextSnapshotErrorCode =
  | 'INPUT_INVALID'
  | 'SNAPSHOT_NOT_FOUND'
  | 'PERSISTENCE_FAILED';

export class MemoryContextSnapshotError extends Error {
  constructor(readonly code: MemoryContextSnapshotErrorCode) {
    super(`MEMORY_CONTEXT_SNAPSHOT_${code}`);
    this.name = 'MemoryContextSnapshotError';
  }
}

export interface CreateMemoryContextSnapshotInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly agentId?: string;
  readonly taskId?: string;
  readonly runId: string;
  readonly stageId?: string;
  readonly providerConfigId?: string;
  readonly queryHash: string;
  readonly retrievalStrategyVersion: string;
  readonly budget: MemoryBudgetPolicyV1;
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly promptArtifactId?: string;
  readonly createdAt: string;
  readonly selected: readonly MemorySelectionExplanationV1[];
  readonly exclusions: readonly MemoryExclusionExplanationV1[];
}

export interface MemoryContextSnapshotRecord {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly agentId: string | null;
  readonly taskId: string | null;
  readonly runId: string;
  readonly stageId: string | null;
  readonly providerConfigId: string | null;
  readonly queryHash: string;
  readonly retrievalStrategyVersion: string;
  readonly budget: MemoryBudgetPolicyV1;
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly promptArtifactId: string | null;
  readonly createdAt: string;
  readonly selected: readonly MemorySelectionExplanationV1[];
  readonly exclusions: readonly MemoryExclusionExplanationV1[];
}

interface SnapshotRow {
  id: string;
  schema_version: number;
  workspace_id: string;
  agent_id: string | null;
  task_id: string | null;
  run_id: string;
  stage_id: string | null;
  provider_config_id: string | null;
  query_hash: string;
  retrieval_strategy_version: string;
  budget_json: string;
  total_tokens: number;
  truncated: number;
  prompt_artifact_id: string | null;
  created_at: string;
}

interface EntryRow {
  snapshot_id: string;
  memory_entry_id: string;
  memory_entry_version: number;
  selected: number;
  rank: number | null;
  score: number | null;
  scope: string | null;
  category: string | null;
  authority: string | null;
  confidence: number | null;
  importance: number | null;
  token_cost: number;
  reasons_json: string;
  source_refs_json: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class MemoryContextSnapshotRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Persist a snapshot and all considered-Entry rows in one transaction. Any
   * invalid input or write failure rolls back the whole snapshot so a Run is
   * never left with a partially recorded context.
   */
  createSnapshot(input: CreateMemoryContextSnapshotInput): MemoryContextSnapshotRecord {
    try {
      return inTransaction(this.db, () => this.createSnapshotWithinTransaction(input));
    } catch (error) {
      throw this.publicError(error);
    }
  }

  /**
   * MF-5 emission seam: persist the snapshot inside an ALREADY ACTIVE
   * transaction so a caller can commit the snapshot and its Runtime Event +
   * Outbox row atomically. The caller owns BEGIN/COMMIT.
   */
  createSnapshotWithinTransaction(input: CreateMemoryContextSnapshotInput): MemoryContextSnapshotRecord {
    this.validateInput(input);
    this.assertRunExists(input.workspaceId, input.runId);
    this.db.prepare(
      'INSERT INTO memory_context_snapshots ('
        + 'id, schema_version, workspace_id, agent_id, task_id, run_id, stage_id, provider_config_id,'
        + ' query_hash, retrieval_strategy_version, budget_json, total_tokens, truncated, prompt_artifact_id, created_at'
        + ') VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      input.id, input.workspaceId, input.agentId ?? null, input.taskId ?? null,
      input.runId, input.stageId ?? null, input.providerConfigId ?? null,
      input.queryHash, input.retrievalStrategyVersion, JSON.stringify(input.budget),
      input.totalTokens, input.truncated ? 1 : 0, input.promptArtifactId ?? null,
      input.createdAt,
    );
    for (const selected of input.selected) {
      this.db.prepare(
        'INSERT INTO memory_context_snapshot_entries ('
          + 'snapshot_id, memory_entry_id, memory_entry_version, selected, rank, score, scope, category,'
          + ' authority, confidence, importance, token_cost, reasons_json, source_refs_json, content_hash'
          + ') VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      ).run(
        input.id, selected.memoryId, selected.memoryVersion, selected.rank, selected.score,
        selected.scope, selected.category, selected.authority, selected.confidence,
        selected.importance, selected.tokenCost, JSON.stringify(selected.reasons),
        JSON.stringify(selected.sourceRefs),
      );
    }
    for (const exclusion of input.exclusions) {
      this.db.prepare(
        'INSERT INTO memory_context_snapshot_entries ('
          + 'snapshot_id, memory_entry_id, memory_entry_version, selected, rank, score, scope, category,'
          + ' authority, confidence, importance, token_cost, reasons_json, source_refs_json, content_hash'
          + ') VALUES (?, ?, 1, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, \'[]\', NULL)',
      ).run(input.id, exclusion.memoryId, JSON.stringify([exclusion.reason]));
    }
    return this.requireSnapshot(input.workspaceId, input.id);
  }

  /** Read one snapshot with its selection and exclusion rows; Workspace-scoped. */
  findById(workspaceId: string, snapshotId: string): MemoryContextSnapshotRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(snapshotId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM memory_context_snapshots WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, snapshotId) as SnapshotRow | undefined;
    if (row === undefined) return undefined;
    return this.toRecord(row);
  }

  /** Latest snapshot for a Run, deterministically ordered. */
  findLatestForScope(workspaceId: string, runId: string, stageId?: string): MemoryContextSnapshotRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(runId)
      || (stageId !== undefined && !nonBlank(stageId))) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM memory_context_snapshots WHERE workspace_id = ? AND run_id = ? AND stage_id IS ? ORDER BY created_at DESC, id DESC LIMIT 1',
    ).get(workspaceId, runId, stageId ?? null) as SnapshotRow | undefined;
    return row === undefined ? undefined : this.toRecord(row);
  }

  /** Latest snapshot across all Stages of a Run, for inspection. */
  findLatestForRun(workspaceId: string, runId: string): MemoryContextSnapshotRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(runId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM memory_context_snapshots WHERE workspace_id = ? AND run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    ).get(workspaceId, runId) as SnapshotRow | undefined;
    if (row === undefined) return undefined;
    return this.toRecord(row);
  }

  /**
   * MF-5 API: every snapshot a Run received, in creation order. A Run with
   * multiple Stages freezes one snapshot per Stage; the read surface must
   * expose all of them so a caller can answer "what did this Run or Stage
   * receive" without guessing which single snapshot is authoritative.
   */
  listForRun(workspaceId: string, runId: string): MemoryContextSnapshotRecord[] {
    if (!nonBlank(workspaceId) || !nonBlank(runId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM memory_context_snapshots WHERE workspace_id = ? AND run_id = ? ORDER BY created_at ASC, id ASC',
    ).all(workspaceId, runId) as SnapshotRow[];
    return rows.map(row => this.toRecord(row));
  }

  private validateInput(input: CreateMemoryContextSnapshotInput): void {
    if (typeof input !== 'object' || input === null) throw new MemoryContextSnapshotError('INPUT_INVALID');
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.runId)
      || !nonBlank(input.queryHash) || !nonBlank(input.retrievalStrategyVersion)
      || !nonBlank(input.createdAt)) {
      throw new MemoryContextSnapshotError('INPUT_INVALID');
    }
    if (!Number.isSafeInteger(input.totalTokens) || input.totalTokens < 0) {
      throw new MemoryContextSnapshotError('INPUT_INVALID');
    }
    if (typeof input.truncated !== 'boolean') throw new MemoryContextSnapshotError('INPUT_INVALID');
    if (typeof input.budget !== 'object' || input.budget === null) {
      throw new MemoryContextSnapshotError('INPUT_INVALID');
    }
    if (!Array.isArray(input.selected) || !Array.isArray(input.exclusions)) {
      throw new MemoryContextSnapshotError('INPUT_INVALID');
    }
    const seen = new Set<string>();
    for (const selected of input.selected) {
      if (!nonBlank(selected.memoryId) || !Number.isSafeInteger(selected.memoryVersion)
        || selected.memoryVersion < 1 || !Number.isSafeInteger(selected.rank) || selected.rank < 1
        || typeof selected.score !== 'number' || !Number.isFinite(selected.score)
        || !Array.isArray(selected.reasons) || selected.reasons.length === 0
        || !Number.isSafeInteger(selected.tokenCost) || selected.tokenCost < 0) {
        throw new MemoryContextSnapshotError('INPUT_INVALID');
      }
      if (seen.has(selected.memoryId)) throw new MemoryContextSnapshotError('INPUT_INVALID');
      seen.add(selected.memoryId);
    }
    for (const exclusion of input.exclusions) {
      if (!nonBlank(exclusion.memoryId) || !nonBlank(exclusion.reason)) {
        throw new MemoryContextSnapshotError('INPUT_INVALID');
      }
      if (seen.has(exclusion.memoryId)) throw new MemoryContextSnapshotError('INPUT_INVALID');
      seen.add(exclusion.memoryId);
    }
  }

  private assertRunExists(workspaceId: string, runId: string): void {
    const row = this.db.prepare('SELECT 1 AS present FROM runs WHERE workspace_id = ? AND id = ?').get(workspaceId, runId);
    if (row === undefined) throw new MemoryContextSnapshotError('INPUT_INVALID');
  }

  private requireSnapshot(workspaceId: string, snapshotId: string): MemoryContextSnapshotRecord {
    const snapshot = this.findById(workspaceId, snapshotId);
    if (snapshot === undefined) throw new MemoryContextSnapshotError('SNAPSHOT_NOT_FOUND');
    return snapshot;
  }

  private toRecord(row: SnapshotRow): MemoryContextSnapshotRecord {
    const entries = this.db.prepare(
      'SELECT * FROM memory_context_snapshot_entries WHERE snapshot_id = ? ORDER BY selected DESC, rank ASC, memory_entry_id ASC',
    ).all(row.id) as EntryRow[];
    const selected: MemorySelectionExplanationV1[] = [];
    const exclusions: MemoryExclusionExplanationV1[] = [];
    for (const entry of entries) {
      const reasons = JSON.parse(entry.reasons_json) as string[];
      if (entry.selected === 1) {
        selected.push({
          memoryId: entry.memory_entry_id,
          memoryVersion: entry.memory_entry_version,
          rank: entry.rank as number,
          score: entry.score as number,
          scope: entry.scope as MemorySelectionExplanationV1['scope'],
          category: entry.category as MemorySelectionExplanationV1['category'],
          authority: entry.authority as MemorySelectionExplanationV1['authority'],
          confidence: entry.confidence as number,
          importance: entry.importance as number,
          tokenCost: entry.token_cost,
          reasons: reasons as MemorySelectionExplanationV1['reasons'],
          sourceRefs: JSON.parse(entry.source_refs_json) as MemorySelectionExplanationV1['sourceRefs'],
        });
      } else {
        exclusions.push({
          memoryId: entry.memory_entry_id,
          reason: (reasons[0] ?? 'status-excluded') as MemoryExclusionExplanationV1['reason'],
        });
      }
    }
    return {
      id: row.id,
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      agentId: row.agent_id,
      taskId: row.task_id,
      runId: row.run_id,
      stageId: row.stage_id,
      providerConfigId: row.provider_config_id,
      queryHash: row.query_hash,
      retrievalStrategyVersion: row.retrieval_strategy_version,
      budget: JSON.parse(row.budget_json) as MemoryBudgetPolicyV1,
      totalTokens: row.total_tokens,
      truncated: row.truncated === 1,
      promptArtifactId: row.prompt_artifact_id,
      createdAt: row.created_at,
      selected,
      exclusions,
    };
  }

  private publicError(error: unknown): MemoryContextSnapshotError {
    if (error instanceof MemoryContextSnapshotError) return error;
    return new MemoryContextSnapshotError('PERSISTENCE_FAILED');
  }
}

/**
 * Injection gate: a Run must not proceed to Provider injection unless its
 * snapshot was persisted, because the Run would otherwise be unreproducible.
 */
export function assertSnapshotPersisted(
  snapshot: MemoryContextSnapshotRecord | undefined,
): asserts snapshot is MemoryContextSnapshotRecord {
  if (snapshot === undefined) {
    throw new MemoryContextSnapshotError('SNAPSHOT_NOT_FOUND');
  }
}
