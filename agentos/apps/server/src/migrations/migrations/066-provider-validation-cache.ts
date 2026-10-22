import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * 066 — Provider Validation Cache (04-Provider-Specification §14.5).
 *
 * Short-term cache for Provider Validation results. cache_key is UNIQUE and
 * holds the canonical hash over (providerConfigId, configurationVersion,
 * executable mtime, environmentProfileVersion, adapterVersion), so a config
 * change, executable replacement, environment profile bump or adapter upgrade
 * always misses the cache. Rows carry the validation result JSON only —
 * never prompt content or secrets.
 */
export const PROVIDER_VALIDATION_CACHE_066_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE provider_validation_cache (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    provider_config_id TEXT NOT NULL,
    cache_key TEXT NOT NULL UNIQUE,
    configuration_version INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX idx_provider_validation_cache_workspace
    ON provider_validation_cache(workspace_id, provider_config_id)`,

  `CREATE INDEX idx_provider_validation_cache_expires
    ON provider_validation_cache(expires_at ASC)`,
]);

export const migration066Checksum = createHash('sha256')
  .update(PROVIDER_VALIDATION_CACHE_066_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration066: Migration = {
  id: '066',
  name: 'provider-validation-cache',
  checksum: migration066Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of PROVIDER_VALIDATION_CACHE_066_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
