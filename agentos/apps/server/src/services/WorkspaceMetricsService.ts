import type { TransactionDatabase } from '../store/Transaction.js';
import type { ProviderMetricsService, ProviderMetricSnapshot } from './ProviderMetricsService.js';

/**
 * 14-Roadmap §181-185 minimal metrics surface. Every value is derived from
 * existing tables / SQLite runtime state — no external dependencies, no new
 * collectors — and no prompt content, secret or free-text payload ever
 * appears in the summary.
 */

export interface RunMetricsSummary {
  readonly windowFrom: string | null;
  readonly windowTo: string | null;
  readonly totalRuns: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly cancelledRuns: number;
  readonly cancelsRequested: number;
  readonly averageCancelLatencyMs: number | null;
}

export interface OutboxMetricsSummary {
  readonly pendingCount: number;
  readonly retryCount: number;
  readonly publishingCount: number;
  readonly deadLetterCount: number;
  /** Age in ms of the oldest due (pending/retry) message; null when empty. */
  readonly oldestPendingAgeMs: number | null;
}

export interface DatabaseMetricsSummary {
  readonly pageSizeBytes: number;
  readonly pageCount: number;
  readonly freelistPages: number;
  /** pageCount * pageSize — total DB file size as seen by SQLite. */
  readonly sizeBytes: number;
  readonly journalMode: string;
  readonly busyTimeoutMs: number;
}

export interface EventMetricsSummary {
  readonly durableRuntimeEventsAppended: number;
  readonly legacyAgentEventsAppended: number;
}

/** 04-Provider-Specification §61 — per-Provider validation/startup metrics. */
export interface ProviderMetricsEntry {
  readonly providerConfigId: string;
  readonly validationCount: number;
  readonly validationSuccessCount: number;
  /** validationSuccessCount / validationCount; null when no validation ran. */
  readonly validationSuccessRate: number | null;
  readonly authFailureCount: number;
  readonly cacheHitCount: number;
  readonly averageValidationLatencyMs: number | null;
  /** Average usage_records duration_ms for this Provider config; null when absent. */
  readonly averageStartupLatencyMs: number | null;
}

export interface WorkspaceMetricsSummary {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly runs: RunMetricsSummary;
  readonly outbox: OutboxMetricsSummary;
  readonly database: DatabaseMetricsSummary;
  readonly events: EventMetricsSummary;
  readonly providers: ProviderMetricsEntry[];
}

interface RunCountRow {
  total_runs: number;
  completed_runs: number;
  failed_runs: number;
  cancelled_runs: number;
  cancels_requested: number;
  avg_cancel_latency_ms: number | null;
}

export class WorkspaceMetricsService {
  private readonly now: () => string;
  private readonly providerMetrics?: ProviderMetricsService;

  constructor(
    private readonly db: TransactionDatabase,
    options: { readonly now?: () => string; readonly providerMetrics?: ProviderMetricsService } = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.providerMetrics = options.providerMetrics;
  }

  get transactionDatabase(): TransactionDatabase {
    return this.db;
  }

  summarizeWorkspace(workspaceId: string, from?: string, to?: string): WorkspaceMetricsSummary {
    const runs = this.db.prepare(`
      SELECT
        COUNT(*) AS total_runs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_runs,
        SUM(CASE WHEN cancellation_requested_at IS NOT NULL THEN 1 ELSE 0 END) AS cancels_requested,
        AVG(CASE
          WHEN status = 'cancelled'
            AND cancellation_requested_at IS NOT NULL
            AND completed_at IS NOT NULL
          THEN MAX(0, (julianday(completed_at) - julianday(cancellation_requested_at)) * 86400000.0)
          ELSE NULL
        END) AS avg_cancel_latency_ms
      FROM runs
      WHERE workspace_id = ?
        AND (? IS NULL OR created_at >= ?)
        AND (? IS NULL OR created_at <= ?)
    `).get(workspaceId, from ?? null, from ?? null, to ?? null, to ?? null) as RunCountRow;

    const outbox = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry_count,
        SUM(CASE WHEN status = 'publishing' THEN 1 ELSE 0 END) AS publishing_count,
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter_count,
        MIN(CASE WHEN status IN ('pending', 'retry') THEN available_at END) AS oldest_due_at
      FROM outbox_messages
    `).get() as {
      pending_count: number | null;
      retry_count: number | null;
      publishing_count: number | null;
      dead_letter_count: number | null;
      oldest_due_at: string | null;
    };

    const pageSize = this.db.prepare('PRAGMA page_size').get() as { page_size: number };
    const pageCount = this.db.prepare('PRAGMA page_count').get() as { page_count: number };
    const freelist = this.db.prepare('PRAGMA freelist_count').get() as { freelist_count: number };
    const journalMode = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const busyTimeout = this.db.prepare('PRAGMA busy_timeout').get() as { timeout: number };

    const runtimeEventCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM runtime_events
      WHERE workspace_id = ?
        AND (? IS NULL OR timestamp >= ?)
        AND (? IS NULL OR timestamp <= ?)
    `).get(workspaceId, from ?? null, from ?? null, to ?? null, to ?? null) as { count: number };

    const agentEventCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM agent_events
      WHERE workspace_id = ?
        AND (? IS NULL OR timestamp >= ?)
        AND (? IS NULL OR timestamp <= ?)
    `).get(workspaceId, from ?? null, from ?? null, to ?? null, to ?? null) as { count: number };

    const startupLatencyRows = this.db.prepare(`
      SELECT provider_config_id, AVG(duration_ms) AS avg_duration_ms
      FROM usage_records
      WHERE workspace_id = ?
        AND provider_config_id IS NOT NULL
        AND duration_ms IS NOT NULL
        AND (? IS NULL OR recorded_at >= ?)
        AND (? IS NULL OR recorded_at <= ?)
      GROUP BY provider_config_id
    `).all(workspaceId, from ?? null, from ?? null, to ?? null, to ?? null) as Array<{
      provider_config_id: string;
      avg_duration_ms: number | null;
    }>;
    const startupLatencyByConfig = new Map(startupLatencyRows
      .filter(row => row.avg_duration_ms !== null)
      .map(row => [row.provider_config_id, Math.round(row.avg_duration_ms as number)]));

    const validationByConfig = new Map<string, ProviderMetricSnapshot>();
    for (const snapshot of this.providerMetrics?.snapshotForWorkspace(workspaceId) ?? []) {
      validationByConfig.set(snapshot.providerConfigId, snapshot);
    }
    const providerConfigIds = [...new Set([
      ...startupLatencyByConfig.keys(),
      ...validationByConfig.keys(),
    ])].sort();
    const providers: ProviderMetricsEntry[] = providerConfigIds.map(providerConfigId => {
      const validation = validationByConfig.get(providerConfigId);
      return {
        providerConfigId,
        validationCount: validation?.validationCount ?? 0,
        validationSuccessCount: validation?.validationSuccessCount ?? 0,
        validationSuccessRate: validation?.validationSuccessRate ?? null,
        authFailureCount: validation?.authFailureCount ?? 0,
        cacheHitCount: validation?.cacheHitCount ?? 0,
        averageValidationLatencyMs: validation?.averageValidationLatencyMs ?? null,
        averageStartupLatencyMs: startupLatencyByConfig.get(providerConfigId) ?? null,
      };
    });

    const generatedAt = this.now();
    const oldestDueAt = outbox.oldest_due_at;
    const oldestPendingAgeMs = oldestDueAt === null
      ? null
      : Math.max(0, Date.parse(generatedAt) - Date.parse(oldestDueAt));

    return {
      workspaceId,
      generatedAt,
      runs: {
        windowFrom: from ?? null,
        windowTo: to ?? null,
        totalRuns: runs.total_runs,
        completedRuns: runs.completed_runs ?? 0,
        failedRuns: runs.failed_runs ?? 0,
        cancelledRuns: runs.cancelled_runs ?? 0,
        cancelsRequested: runs.cancels_requested ?? 0,
        averageCancelLatencyMs: runs.avg_cancel_latency_ms === null
          ? null
          : Math.round(runs.avg_cancel_latency_ms),
      },
      outbox: {
        pendingCount: outbox.pending_count ?? 0,
        retryCount: outbox.retry_count ?? 0,
        publishingCount: outbox.publishing_count ?? 0,
        deadLetterCount: outbox.dead_letter_count ?? 0,
        oldestPendingAgeMs,
      },
      database: {
        pageSizeBytes: pageSize.page_size,
        pageCount: pageCount.page_count,
        freelistPages: freelist.freelist_count,
        sizeBytes: pageSize.page_size * pageCount.page_count,
        journalMode: journalMode.journal_mode,
        busyTimeoutMs: busyTimeout.timeout,
      },
      events: {
        durableRuntimeEventsAppended: runtimeEventCount.count,
        legacyAgentEventsAppended: agentEventCount.count,
      },
      providers,
    };
  }
}
