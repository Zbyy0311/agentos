import type { UsageRepository } from '../store/UsageRepository.js';
import type { TransactionDatabase } from '../store/Transaction.js';

/**
 * §23/§50 Usage aggregation — derives metric-only Usage Records from durable
 * runtime facts:
 *
 * 1. `execution.usage.recorded` legacy runtime events (Provider token usage),
 *    idempotency key = the source event id.
 * 2. canonical Run terminal completion (duration, no tokens), idempotency key
 *    = `run-completion:<runId>` — a Run completes at most once per id, and the
 *    UNIQUE(source_event_id) constraint makes replay a no-op.
 *
 * Only whitelisted metric fields are read out of event payloads; prompt
 * content, stdout and any free-text payload fields are never persisted.
 * All writes go through UsageRepository.recordUsageWithinTransaction on the
 * caller's transaction, so replay is idempotent even across re-delivery.
 */

export const RUN_COMPLETION_SOURCE_EVENT_PREFIX = 'run-completion:';

export interface UsageIngestResult {
  readonly usageEventRecordsInserted: number;
  readonly runCompletionRecordsInserted: number;
}

interface AgentUsageEventRow {
  event_id: string;
  run_id: string;
  execution_id: string | null;
  agent_id: string | null;
  timestamp: string;
  payload_json: string;
}

interface CompletedRunRow {
  id: string;
  started_at: string | null;
  completed_at: string;
}

function readMetricTokens(payload: Record<string, unknown>): {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
} {
  const read = (key: string): number => {
    const value = payload[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  return {
    inputTokens: read('inputTokens'),
    cachedInputTokens: read('cachedInputTokens'),
    outputTokens: read('outputTokens'),
  };
}

export class UsageAggregator {
  constructor(
    private readonly db: TransactionDatabase,
    private readonly usage: UsageRepository,
  ) {}

  /**
   * Incrementally ingest usage-bearing facts for one Workspace. Safe to call
   * on every read: already-ingested source facts are skipped via the UNIQUE
   * source_event_id constraint and return inserted=false.
   */
  ingestWorkspaceUsageWithinTransaction(workspaceId: string): UsageIngestResult {
    let usageEventRecordsInserted = 0;
    const events = this.db.prepare(`
      SELECT event_id, run_id, execution_id, agent_id, timestamp, payload_json
      FROM agent_events
      WHERE workspace_id = ? AND event_type = 'execution.usage.recorded'
      ORDER BY timestamp ASC, event_id ASC
    `).all(workspaceId) as AgentUsageEventRow[];

    for (const event of events) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue;
      } catch {
        continue;
      }
      const tokens = readMetricTokens(payload);
      const result = this.usage.recordUsageWithinTransaction({
        workspaceId,
        runId: event.run_id,
        source: typeof payload.source === 'string' ? payload.source : null,
        provider: typeof payload.provider === 'string' ? payload.provider : null,
        model: typeof payload.model === 'string' ? payload.model : null,
        ...tokens,
        totalTokens: tokens.inputTokens + tokens.outputTokens,
        estimated: payload.estimated === true,
        sourceEventId: event.event_id,
        recordedAt: event.timestamp,
      });
      if (result.inserted) usageEventRecordsInserted += 1;
    }

    let runCompletionRecordsInserted = 0;
    const runs = this.db.prepare(`
      SELECT id, started_at, completed_at
      FROM runs
      WHERE workspace_id = ? AND status = 'completed' AND completed_at IS NOT NULL
      ORDER BY completed_at ASC, id ASC
    `).all(workspaceId) as CompletedRunRow[];

    for (const run of runs) {
      const durationMs = run.started_at === null
        ? null
        : Math.max(0, Date.parse(run.completed_at) - Date.parse(run.started_at));
      const result = this.usage.recordUsageWithinTransaction({
        workspaceId,
        runId: run.id,
        durationMs,
        estimated: false,
        sourceEventId: `${RUN_COMPLETION_SOURCE_EVENT_PREFIX}${run.id}`,
        recordedAt: run.completed_at,
      });
      if (result.inserted) runCompletionRecordsInserted += 1;
    }

    return { usageEventRecordsInserted, runCompletionRecordsInserted };
  }
}
