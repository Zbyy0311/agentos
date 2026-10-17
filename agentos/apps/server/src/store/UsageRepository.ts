import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { createEntityId, isValidEntityId } from './Identity.js';
import type { TransactionDatabase } from './Transaction.js';

/**
 * §23 / §50 Usage Record — metric-only resource consumption ledger.
 *
 * Rows are derived from durable runtime facts (usage events, Run/Stage
 * completion). Only metric fields are representable here: tokens, duration,
 * estimated flag and source/provider/model identity. Prompt content, stdout
 * or any free-text payload is never stored.
 *
 * Idempotency: source_event_id is UNIQUE — replaying the same source event
 * returns the existing row with inserted=false instead of duplicating it.
 */

export class UsageRepositoryError extends Error {
  constructor(
    readonly code:
      | 'USAGE_RECORD_VALIDATION_FAILED'
      | 'USAGE_RECORD_PERSISTENCE_FAILED'
      | 'USAGE_RECORD_READ_FAILED',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'UsageRepositoryError';
  }
}

export interface UsageRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly stageId: string | null;
  readonly processId: string | null;
  readonly providerConfigId: string | null;
  readonly source: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly durationMs: number | null;
  readonly estimated: boolean;
  readonly recordedAt: string;
  readonly sourceEventId: string;
  readonly createdAt: string;
}

export interface RecordUsageInput {
  readonly workspaceId: string;
  readonly runId?: string | null;
  readonly stageId?: string | null;
  readonly processId?: string | null;
  readonly providerConfigId?: string | null;
  readonly source?: string | null;
  readonly provider?: string | null;
  readonly model?: string | null;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly durationMs?: number | null;
  readonly estimated?: boolean;
  /** Event / completion fact this record was derived from (idempotency key). */
  readonly sourceEventId: string;
  readonly recordedAt: string;
}

export interface RecordUsageResult {
  readonly record: UsageRecord;
  readonly inserted: boolean;
}

export interface UsageRecordQuery {
  readonly workspaceId: string;
  readonly runId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface UsageRecordPage {
  readonly records: readonly UsageRecord[];
  readonly hasMore: boolean;
  /** Pass as `cursor` on the next request, when hasMore is true. */
  readonly nextCursor: string | null;
}

export type UsageSummaryGroupBy = 'provider' | 'run';

export interface UsageSummaryQuery {
  readonly workspaceId: string;
  readonly from?: string;
  readonly to?: string;
  readonly groupBy: UsageSummaryGroupBy;
}

export interface UsageSummaryBucket {
  readonly key: string;
  readonly recordCount: number;
  readonly estimatedRecordCount: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly avgDurationMs: number | null;
}

export interface UsageSummaryResult {
  readonly groupBy: UsageSummaryGroupBy;
  readonly from: string | null;
  readonly to: string | null;
  readonly buckets: readonly UsageSummaryBucket[];
}

export const USAGE_RECORD_DEFAULT_LIMIT = 50;
export const USAGE_RECORD_MAX_LIMIT = 200;

interface UsageRecordRow {
  id: string;
  workspace_id: string;
  run_id: string | null;
  stage_id: string | null;
  process_id: string | null;
  provider_config_id: string | null;
  source: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  duration_ms: number | null;
  estimated: number;
  recorded_at: string;
  source_event_id: string;
  created_at: string;
}

function optionalText(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : value;
}

function nonNegativeInteger(value: number | undefined, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageRepositoryError(
      'USAGE_RECORD_VALIDATION_FAILED',
      `${field} must be a non-negative safe integer`,
    );
  }
  return value;
}

function optionalNonNegativeInteger(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageRepositoryError(
      'USAGE_RECORD_VALIDATION_FAILED',
      `${field} must be null or a non-negative safe integer`,
    );
  }
  return value;
}

function optionalShortLabel(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new UsageRepositoryError(
      'USAGE_RECORD_VALIDATION_FAILED',
      `${field} must be null or a 1-128 char label`,
    );
  }
  return value;
}

function mapRow(row: UsageRecordRow): UsageRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    stageId: row.stage_id,
    processId: row.process_id,
    providerConfigId: row.provider_config_id,
    source: row.source,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    durationMs: row.duration_ms,
    estimated: row.estimated === 1,
    recordedAt: row.recorded_at,
    sourceEventId: row.source_event_id,
    createdAt: row.created_at,
  };
}

export class UsageRepository {
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(
    private readonly db: TransactionDatabase,
    options: { readonly createId?: () => string; readonly now?: () => string } = {},
  ) {
    this.createId = options.createId ?? (() => createEntityId('usageRecord'));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** Identity assertion seam: composing services share ONE SQLite connection. */
  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  recordUsageWithinTransaction(input: RecordUsageInput): RecordUsageResult {
    if (!isValidEntityId(input.workspaceId, 'workspace')) {
      throw new UsageRepositoryError(
        'USAGE_RECORD_VALIDATION_FAILED',
        'workspaceId must be a canonical ws_ id',
      );
    }
    if (typeof input.sourceEventId !== 'string' || input.sourceEventId.trim().length === 0
      || input.sourceEventId.length > 256) {
      throw new UsageRepositoryError(
        'USAGE_RECORD_VALIDATION_FAILED',
        'sourceEventId is required (max 256 chars)',
      );
    }
    if (!isCanonicalUtcTimestamp(input.recordedAt)) {
      throw new UsageRepositoryError(
        'USAGE_RECORD_VALIDATION_FAILED',
        'recordedAt must be canonical UTC ISO 8601 milliseconds',
      );
    }

    const existing = this.findBySourceEventId(input.sourceEventId);
    if (existing) {
      return { record: existing, inserted: false };
    }

    const inputTokens = nonNegativeInteger(input.inputTokens, 'inputTokens');
    const outputTokens = nonNegativeInteger(input.outputTokens, 'outputTokens');
    const explicitTotalTokens = nonNegativeInteger(input.totalTokens, 'totalTokens');
    const totalTokens = explicitTotalTokens === 0 && inputTokens + outputTokens > 0
      ? inputTokens + outputTokens
      : explicitTotalTokens;

    const record: UsageRecord = {
      id: this.createId(),
      workspaceId: input.workspaceId,
      runId: optionalText(input.runId),
      stageId: optionalText(input.stageId),
      processId: optionalText(input.processId),
      providerConfigId: optionalText(input.providerConfigId),
      source: optionalShortLabel(input.source, 'source'),
      provider: optionalShortLabel(input.provider, 'provider'),
      model: optionalShortLabel(input.model, 'model'),
      inputTokens,
      cachedInputTokens: nonNegativeInteger(input.cachedInputTokens, 'cachedInputTokens'),
      outputTokens,
      totalTokens,
      durationMs: optionalNonNegativeInteger(input.durationMs, 'durationMs'),
      estimated: input.estimated === true,
      recordedAt: input.recordedAt,
      sourceEventId: input.sourceEventId,
      createdAt: this.now(),
    };

    try {
      this.db.prepare(`
        INSERT INTO usage_records (
          id, workspace_id, run_id, stage_id, process_id, provider_config_id,
          source, provider, model, input_tokens, cached_input_tokens,
          output_tokens, total_tokens, duration_ms, estimated,
          recorded_at, source_event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.workspaceId,
        record.runId,
        record.stageId,
        record.processId,
        record.providerConfigId,
        record.source,
        record.provider,
        record.model,
        record.inputTokens,
        record.cachedInputTokens,
        record.outputTokens,
        record.totalTokens,
        record.durationMs,
        record.estimated ? 1 : 0,
        record.recordedAt,
        record.sourceEventId,
        record.createdAt,
      );
    } catch {
      // UNIQUE(source_event_id) races resolve as idempotent replays.
      const raced = this.findBySourceEventId(input.sourceEventId);
      if (raced) return { record: raced, inserted: false };
      throw new UsageRepositoryError(
        'USAGE_RECORD_PERSISTENCE_FAILED',
        'Usage Record could not be persisted',
      );
    }
    return { record, inserted: true };
  }

  findBySourceEventId(sourceEventId: string): UsageRecord | undefined {
    const row = this.db.prepare(`
      SELECT * FROM usage_records WHERE source_event_id = ?
    `).get(sourceEventId) as UsageRecordRow | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  getById(id: string): UsageRecord | undefined {
    const row = this.db.prepare('SELECT * FROM usage_records WHERE id = ?').get(id) as UsageRecordRow | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  countByWorkspace(workspaceId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM usage_records WHERE workspace_id = ?',
    ).get(workspaceId) as { count: number };
    return row.count;
  }

  queryRecords(input: UsageRecordQuery): UsageRecordPage {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > USAGE_RECORD_MAX_LIMIT) {
      throw new UsageRepositoryError(
        'USAGE_RECORD_VALIDATION_FAILED',
        `limit must be between 1 and ${USAGE_RECORD_MAX_LIMIT}`,
      );
    }
    for (const [field, value] of [['from', input.from], ['to', input.to]] as const) {
      if (value !== undefined && !isCanonicalUtcTimestamp(value)) {
        throw new UsageRepositoryError(
          'USAGE_RECORD_VALIDATION_FAILED',
          `${field} must be canonical UTC ISO 8601 milliseconds`,
        );
      }
    }
    if (input.cursor !== undefined && !isValidEntityId(input.cursor, 'usageRecord')) {
      throw new UsageRepositoryError(
        'USAGE_RECORD_VALIDATION_FAILED',
        'cursor must be a canonical urec_ id',
      );
    }

    const conditions = ['workspace_id = ?'];
    const parameters: unknown[] = [input.workspaceId];
    if (input.runId !== undefined) {
      conditions.push('run_id = ?');
      parameters.push(input.runId);
    }
    if (input.from !== undefined) {
      conditions.push('recorded_at >= ?');
      parameters.push(input.from);
    }
    if (input.to !== undefined) {
      conditions.push('recorded_at <= ?');
      parameters.push(input.to);
    }
    if (input.cursor !== undefined) {
      // (recorded_at, id) composite keyset pagination keeps ordering stable
      // even when several records share one recorded_at millisecond.
      const cursorRow = this.db.prepare(
        'SELECT recorded_at FROM usage_records WHERE id = ?',
      ).get(input.cursor) as { recorded_at: string } | undefined;
      if (cursorRow === undefined) {
        throw new UsageRepositoryError('USAGE_RECORD_READ_FAILED', 'cursor record does not exist');
      }
      conditions.push('(recorded_at > ? OR (recorded_at = ? AND id > ?))');
      parameters.push(cursorRow.recorded_at, cursorRow.recorded_at, input.cursor);
    }
    parameters.push(input.limit + 1);

    const rows = this.db.prepare(`
      SELECT * FROM usage_records
      WHERE ${conditions.join(' AND ')}
      ORDER BY recorded_at ASC, id ASC
      LIMIT ?
    `).all(...parameters) as UsageRecordRow[];

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      records: page.map(mapRow),
      hasMore,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  summarize(input: UsageSummaryQuery): UsageSummaryResult {
    for (const [field, value] of [['from', input.from], ['to', input.to]] as const) {
      if (value !== undefined && !isCanonicalUtcTimestamp(value)) {
        throw new UsageRepositoryError(
          'USAGE_RECORD_VALIDATION_FAILED',
          `${field} must be canonical UTC ISO 8601 milliseconds`,
        );
      }
    }
    const groupExpression = input.groupBy === 'provider' ? 'provider' : 'run_id';
    const conditions = ['workspace_id = ?'];
    const parameters: unknown[] = [input.workspaceId];
    if (input.from !== undefined) {
      conditions.push('recorded_at >= ?');
      parameters.push(input.from);
    }
    if (input.to !== undefined) {
      conditions.push('recorded_at <= ?');
      parameters.push(input.to);
    }

    const rows = this.db.prepare(`
      SELECT
        ${groupExpression} AS bucket_key,
        COUNT(*) AS record_count,
        SUM(estimated) AS estimated_record_count,
        SUM(input_tokens) AS total_input_tokens,
        SUM(output_tokens) AS total_output_tokens,
        SUM(total_tokens) AS total_tokens,
        SUM(COALESCE(duration_ms, 0)) AS total_duration_ms,
        AVG(duration_ms) AS avg_duration_ms
      FROM usage_records
      WHERE ${conditions.join(' AND ')}
      GROUP BY ${groupExpression}
      ORDER BY bucket_key ASC
    `).all(...parameters) as Array<{
      bucket_key: string | null;
      record_count: number;
      estimated_record_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      total_tokens: number;
      total_duration_ms: number;
      avg_duration_ms: number | null;
    }>;

    return {
      groupBy: input.groupBy,
      from: input.from ?? null,
      to: input.to ?? null,
      buckets: rows.map(row => ({
        key: row.bucket_key ?? '(none)',
        recordCount: row.record_count,
        estimatedRecordCount: row.estimated_record_count,
        totalInputTokens: row.total_input_tokens,
        totalOutputTokens: row.total_output_tokens,
        totalTokens: row.total_tokens,
        totalDurationMs: row.total_duration_ms,
        avgDurationMs: row.avg_duration_ms,
      })),
    };
  }
}
