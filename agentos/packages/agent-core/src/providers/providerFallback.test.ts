import { describe, expect, it } from 'vitest';
import type { ProviderFallbackChainEntryV1 } from '@agentos/shared';
import {
  attemptedProviderConfigIds,
  fallbackBudgetExhausted,
  fallbackChainForStage,
  isFallbackTriggerCode,
  normalizeProviderFallbackPolicy,
  selectFallbackTargetId,
  MAX_FALLBACK_PROVIDER_CONFIG_IDS,
} from './fallback.js';

function policy(overrides: Record<string, unknown> = {}) {
  return normalizeProviderFallbackPolicy({
    enabled: true,
    fallbackProviderConfigIds: ['cfg-b', 'cfg-c'],
    triggerErrorCodes: ['PROVIDER_RATE_LIMITED', 'PROVIDER_QUOTA_EXCEEDED'],
    maxFallbacks: 2,
    requireUserApproval: false,
    ...overrides,
  })!;
}

describe('normalizeProviderFallbackPolicy', () => {
  it('returns undefined for absent policies', () => {
    expect(normalizeProviderFallbackPolicy(undefined)).toBeUndefined();
    expect(normalizeProviderFallbackPolicy(null)).toBeUndefined();
  });

  it('accepts a valid policy and clones its arrays', () => {
    const source = {
      enabled: true,
      fallbackProviderConfigIds: ['a'],
      triggerErrorCodes: ['PROVIDER_RATE_LIMITED'],
      maxFallbacks: 1,
      requireUserApproval: true,
    };
    const normalized = normalizeProviderFallbackPolicy(source)!;
    expect(normalized).toEqual(source);
    expect(normalized.fallbackProviderConfigIds).not.toBe(source.fallbackProviderConfigIds);
  });

  it('rejects malformed policies', () => {
    expect(() => normalizeProviderFallbackPolicy('nope')).toThrow(/object/);
    expect(() => policy({ enabled: 'yes' })).toThrow(/enabled/);
    expect(() => policy({ fallbackProviderConfigIds: [1] })).toThrow(/fallbackProviderConfigIds/);
    expect(() => policy({ fallbackProviderConfigIds: [] })).not.toThrow();
    expect(() => policy({ triggerErrorCodes: ['NOT_A_CODE'] })).toThrow(/unknown triggerErrorCode/);
    expect(() => policy({ maxFallbacks: -1 })).toThrow(/maxFallbacks/);
    expect(() => policy({ maxFallbacks: 1.5 })).toThrow(/maxFallbacks/);
    expect(() => policy({ requireUserApproval: 1 })).toThrow(/requireUserApproval/);
  });

  it('bounds the candidate list', () => {
    expect(() => policy({
      fallbackProviderConfigIds: Array.from({ length: MAX_FALLBACK_PROVIDER_CONFIG_IDS + 1 }, (_, i) => 'cfg-' + i),
    })).toThrow(/bounded/);
  });
});

describe('isFallbackTriggerCode', () => {
  it('only triggers on listed normalized codes', () => {
    const p = policy();
    expect(isFallbackTriggerCode(p, 'PROVIDER_RATE_LIMITED')).toBe(true);
    expect(isFallbackTriggerCode(p, 'PROVIDER_QUOTA_EXCEEDED')).toBe(true);
    expect(isFallbackTriggerCode(p, 'PROVIDER_START_FAILED')).toBe(false);
    expect(isFallbackTriggerCode(p, 'RUNTIME_APPROVAL_REJECTED')).toBe(false);
    expect(isFallbackTriggerCode(p, 'provider_rate_limited')).toBe(false);
  });

  it('never triggers when the policy is disabled', () => {
    expect(isFallbackTriggerCode(policy({ enabled: false }), 'PROVIDER_RATE_LIMITED')).toBe(false);
  });
});

describe('selectFallbackTargetId', () => {
  it('returns candidates in policy order, skipping attempted configurations', () => {
    const p = policy();
    expect(selectFallbackTargetId(p, new Set(['cfg-a']))).toBe('cfg-b');
    expect(selectFallbackTargetId(p, new Set(['cfg-a', 'cfg-b']))).toBe('cfg-c');
    expect(selectFallbackTargetId(p, new Set(['cfg-a', 'cfg-b', 'cfg-c']))).toBeUndefined();
  });

  it('returns undefined for a disabled policy', () => {
    expect(selectFallbackTargetId(policy({ enabled: false }), new Set())).toBeUndefined();
  });
});

describe('fallback budget and chain helpers', () => {
  const entry = (attempt: number, toProviderConfigId: string, stageId = 'stage-1'): ProviderFallbackChainEntryV1 => ({
    sequence: attempt,
    stageId,
    stageAttempt: attempt + 1,
    fromProviderConfigId: attempt === 1 ? 'cfg-a' : 'cfg-b',
    toProviderConfigId,
    triggerErrorCode: 'PROVIDER_RATE_LIMITED',
    attempt,
    switchedAt: '2026-10-17T00:00:00.000Z',
  });

  it('enforces maxFallbacks per stage', () => {
    const p = policy({ maxFallbacks: 1 });
    expect(fallbackBudgetExhausted(p, undefined, 'stage-1')).toBe(false);
    expect(fallbackBudgetExhausted(p, [entry(1, 'cfg-b')], 'stage-1')).toBe(true);
    expect(fallbackBudgetExhausted(p, [entry(1, 'cfg-b')], 'stage-2')).toBe(false);
    expect(fallbackBudgetExhausted(policy({ maxFallbacks: 0 }), undefined, 'stage-1')).toBe(true);
  });

  it('collects attempted ids primary-first and filters chains per stage', () => {
    const chain = [entry(1, 'cfg-b'), entry(2, 'cfg-c', 'stage-2')];
    expect([...attemptedProviderConfigIds(chain, 'stage-1', 'cfg-a')].sort()).toEqual(['cfg-a', 'cfg-b']);
    expect(fallbackChainForStage(chain, 'stage-2')).toHaveLength(1);
    expect(fallbackChainForStage(chain, 'missing')).toHaveLength(0);
    expect(fallbackChainForStage(undefined, 'stage-1')).toHaveLength(0);
  });
});
