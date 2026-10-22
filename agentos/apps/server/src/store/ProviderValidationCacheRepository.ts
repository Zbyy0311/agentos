import type { TransactionDatabase } from './Transaction.js';
import { createEntityId } from './Identity.js';

interface CacheRow {
  id: string;
  workspace_id: string;
  provider_config_id: string;
  cache_key: string;
  configuration_version: number;
  result_json: string;
  created_at: string;
  expires_at: string;
}

/**
 * 04-Provider-Specification §14.5 — short-term Provider Validation Cache store.
 * cache_key is UNIQUE (canonical hash over providerConfigId, configurationVersion,
 * executable mtime, environmentProfileVersion, adapterVersion); expired rows are
 * pruned lazily on read and write.
 */
export class ProviderValidationCacheRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Returns the stored result JSON when the key exists and has not expired
   * (expires_at is compared against `now`), otherwise null. Best-effort prunes
   * expired rows for the same Provider configuration on every read.
   */
  get(cacheKey: string, now: string): string | null {
    this.pruneExpired(now);
    const row = this.db.prepare(`
      SELECT result_json FROM provider_validation_cache
      WHERE cache_key = ? AND expires_at > ?
    `).get(cacheKey, now) as { result_json: string } | undefined;
    return row?.result_json ?? null;
  }

  /** Upserts the cached result for a cache key; replaces any existing row. */
  set(input: {
    workspaceId: string;
    providerConfigId: string;
    cacheKey: string;
    configurationVersion: number;
    resultJson: string;
    now: string;
    ttlMs: number;
  }): void {
    this.pruneExpired(input.now);
    const expiresAt = new Date(Date.parse(input.now) + input.ttlMs).toISOString();
    this.db.prepare(`
      INSERT INTO provider_validation_cache
        (id, workspace_id, provider_config_id, cache_key, configuration_version, result_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        result_json = excluded.result_json,
        configuration_version = excluded.configuration_version,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(
      createEntityId('providerValidationCache'),
      input.workspaceId,
      input.providerConfigId,
      input.cacheKey,
      input.configurationVersion,
      input.resultJson,
      input.now,
      expiresAt,
    );
  }

  /** Deletes all expired rows (lazy expiry cleanup). */
  pruneExpired(now: string): void {
    this.db.prepare('DELETE FROM provider_validation_cache WHERE expires_at <= ?').run(now);
  }

  /** Test/diagnostic helper: raw row lookup. */
  findByKey(cacheKey: string): CacheRow | undefined {
    return this.db.prepare('SELECT * FROM provider_validation_cache WHERE cache_key = ?')
      .get(cacheKey) as CacheRow | undefined;
  }
}
