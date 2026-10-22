/**
 * 04-Provider-Specification §61 — minimal in-memory Provider metrics counters.
 *
 * Validation-path counters (attempts, successes, auth failures, cache hits,
 * latency samples) are process-local aggregates keyed by workspace and
 * Provider configuration. The metrics/summary surface merges them with
 * persistent usage_records data (startup latency) — no prompt content or
 * secret ever flows through here.
 */

export interface ProviderValidationMetricSample {
  readonly workspaceId: string;
  readonly providerConfigId: string;
  readonly valid: boolean;
  readonly authFailure: boolean;
  readonly fromCache: boolean;
  readonly latencyMs: number;
}

interface ProviderMetricAggregate {
  validationCount: number;
  validationSuccessCount: number;
  authFailureCount: number;
  cacheHitCount: number;
  latencyTotalMs: number;
  latencySampleCount: number;
}

function emptyAggregate(): ProviderMetricAggregate {
  return {
    validationCount: 0,
    validationSuccessCount: 0,
    authFailureCount: 0,
    cacheHitCount: 0,
    latencyTotalMs: 0,
    latencySampleCount: 0,
  };
}

export interface ProviderMetricSnapshot {
  readonly providerConfigId: string;
  readonly validationCount: number;
  readonly validationSuccessCount: number;
  readonly validationSuccessRate: number | null;
  readonly authFailureCount: number;
  readonly cacheHitCount: number;
  readonly averageValidationLatencyMs: number | null;
}

export class ProviderMetricsService {
  private readonly aggregates = new Map<string, ProviderMetricAggregate>();

  private static key(workspaceId: string, providerConfigId: string): string {
    return `ws:${workspaceId}\npc:${providerConfigId}`;
  }

  recordValidation(sample: ProviderValidationMetricSample): void {
    const key = ProviderMetricsService.key(sample.workspaceId, sample.providerConfigId);
    let aggregate = this.aggregates.get(key);
    if (aggregate === undefined) {
      aggregate = emptyAggregate();
      this.aggregates.set(key, aggregate);
    }
    aggregate.validationCount += 1;
    if (sample.valid) aggregate.validationSuccessCount += 1;
    if (sample.authFailure) aggregate.authFailureCount += 1;
    if (sample.fromCache) aggregate.cacheHitCount += 1;
    if (!sample.fromCache) {
      aggregate.latencyTotalMs += Math.max(0, sample.latencyMs);
      aggregate.latencySampleCount += 1;
    }
  }

  snapshotForWorkspace(workspaceId: string): ProviderMetricSnapshot[] {
    const prefix = `ws:${workspaceId}\npc:`;
    const snapshots: ProviderMetricSnapshot[] = [];
    for (const [key, aggregate] of this.aggregates) {
      if (!key.startsWith(prefix)) continue;
      const providerConfigId = key.slice(prefix.length);
      snapshots.push({
        providerConfigId,
        validationCount: aggregate.validationCount,
        validationSuccessCount: aggregate.validationSuccessCount,
        validationSuccessRate: aggregate.validationCount === 0
          ? null
          : aggregate.validationSuccessCount / aggregate.validationCount,
        authFailureCount: aggregate.authFailureCount,
        cacheHitCount: aggregate.cacheHitCount,
        averageValidationLatencyMs: aggregate.latencySampleCount === 0
          ? null
          : Math.round(aggregate.latencyTotalMs / aggregate.latencySampleCount),
      });
    }
    return snapshots.sort((a, b) => a.providerConfigId.localeCompare(b.providerConfigId));
  }

  /** Test helper: drops all counters. */
  clear(): void {
    this.aggregates.clear();
  }
}

/** Shared instance used by the provider and metrics routes unless injected. */
export const sharedProviderMetricsService = new ProviderMetricsService();
