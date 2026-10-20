import { createHash } from 'node:crypto';

/**
 * 04-Provider-Specification §14.5 — short-term Provider Validation Cache.
 *
 * The cache key is a canonical hash over every input that can change the
 * validation outcome: the Provider configuration identity, its optimistic
 * configuration version, the resolved executable mtime and path identity, the
 * environment profile version and the frozen adapter version. Any change must
 * produce a different key, so stale results can never be replayed.
 */

export interface ProviderValidationCacheKeyParts {
  readonly providerConfigId: string;
  readonly configurationVersion: number;
  /** Executable file mtime in ms since epoch; null when it cannot be resolved. */
  readonly executableMtimeMs: number | null;
  /** Canonical resolved executable path, kept only inside the hashed cache key. */
  readonly executablePath?: string | null;
  /** Stable filesystem identity used to detect same-mtime replacements. */
  readonly executableFingerprint?: string | null;
  /** Environment profile version; callers must bypass caching for an attached unversioned profile. */
  readonly environmentProfileVersion: number | null;
  readonly adapterVersion: string;
}

export function computeProviderValidationCacheKey(parts: ProviderValidationCacheKeyParts): string {
  const canonical = JSON.stringify({
    providerConfigId: parts.providerConfigId,
    configurationVersion: parts.configurationVersion,
    executableMtimeMs: parts.executableMtimeMs,
    executablePath: parts.executablePath ?? null,
    executableFingerprint: parts.executableFingerprint ?? null,
    environmentProfileVersion: parts.environmentProfileVersion,
    adapterVersion: parts.adapterVersion,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export const DEFAULT_PROVIDER_VALIDATION_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolves the validation cache TTL from the environment.
 * AGENTOS_PROVIDER_VALIDATION_CACHE_TTL_MS overrides the 5 minute default;
 * 0 disables the cache entirely. Invalid or negative values fall back to the
 * default.
 */
export function resolveProviderValidationCacheTtlMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.AGENTOS_PROVIDER_VALIDATION_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_PROVIDER_VALIDATION_CACHE_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PROVIDER_VALIDATION_CACHE_TTL_MS;
  return parsed;
}
