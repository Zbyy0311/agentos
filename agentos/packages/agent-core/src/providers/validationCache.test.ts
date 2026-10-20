import { describe, expect, it } from 'vitest';
import {
  computeProviderValidationCacheKey,
  resolveProviderValidationCacheTtlMs,
  DEFAULT_PROVIDER_VALIDATION_CACHE_TTL_MS,
} from './validationCache.js';

describe('provider validation cache key', () => {
  it('is deterministic and field-order independent', () => {
    const a = computeProviderValidationCacheKey({
      providerConfigId: 'provider-1',
      configurationVersion: 3,
      executableMtimeMs: 1234,
      executablePath: 'C:/tools/provider.exe',
      executableFingerprint: 'dev:ino:size:mtime:ctime',
      environmentProfileVersion: null,
      adapterVersion: 'builtin.custom-cli@1',
    });
    const b = computeProviderValidationCacheKey({
      providerConfigId: 'provider-1',
      configurationVersion: 3,
      executableMtimeMs: 1234,
      executablePath: 'C:/tools/provider.exe',
      executableFingerprint: 'dev:ino:size:mtime:ctime',
      environmentProfileVersion: null,
      adapterVersion: 'builtin.custom-cli@1',
    });
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any invalidating input changes', () => {
    const base = {
      providerConfigId: 'provider-1',
      configurationVersion: 3,
      executableMtimeMs: 1234,
      executablePath: 'C:/tools/provider.exe',
      executableFingerprint: 'dev:ino:size:mtime:ctime',
      environmentProfileVersion: null,
      adapterVersion: 'builtin.custom-cli@1',
    };
    const baseKey = computeProviderValidationCacheKey(base);
    const variants = [
      { ...base, providerConfigId: 'provider-2' },
      { ...base, configurationVersion: 4 },
      { ...base, executableMtimeMs: 5678 },
      { ...base, executableMtimeMs: null },
      { ...base, executablePath: 'D:/other/provider.exe' },
      { ...base, executableFingerprint: 'dev:replacement:size:mtime:ctime' },
      { ...base, environmentProfileVersion: 2 },
      { ...base, adapterVersion: 'builtin.custom-cli@2' },
    ];
    for (const variant of variants) {
      expect(computeProviderValidationCacheKey(variant)).not.toEqual(baseKey);
    }
  });
});

describe('provider validation cache TTL', () => {
  it('defaults to five minutes', () => {
    expect(DEFAULT_PROVIDER_VALIDATION_CACHE_TTL_MS).toEqual(5 * 60 * 1000);
    expect(resolveProviderValidationCacheTtlMs({})).toEqual(DEFAULT_PROVIDER_VALIDATION_CACHE_TTL_MS);
  });

  it('honors env override and treats 0 as cache disabled', () => {
    expect(resolveProviderValidationCacheTtlMs({ AGENTOS_PROVIDER_VALIDATION_CACHE_TTL_MS: '1000' })).toEqual(1000);
    expect(resolveProviderValidationCacheTtlMs({ AGENTOS_PROVIDER_VALIDATION_CACHE_TTL_MS: '0' })).toEqual(0);
  });

  it('falls back to the default for invalid values', () => {
    for (const raw of ['', 'not-a-number', '-5', 'Infinity']) {
      expect(resolveProviderValidationCacheTtlMs({ AGENTOS_PROVIDER_VALIDATION_CACHE_TTL_MS: raw }))
        .toEqual(DEFAULT_PROVIDER_VALIDATION_CACHE_TTL_MS);
    }
  });
});
