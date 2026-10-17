/**
 * P5D Provider Fallback policy logic (04-Provider-Specification §42).
 *
 * Pure, side-effect-free helpers shared by the server dispatch chain. The
 * durable execution (new provider attempt, `provider.switch` Event, approval
 * gating) lives in the server; everything here is decision logic over the
 * frozen ProviderFallbackPolicyV1 so it can be unit-tested without a store.
 */
import { PROVIDER_ERROR_CODES } from '@agentos/shared';
import type { ProviderFallbackChainEntryV1, ProviderFallbackPolicyV1 } from '@agentos/shared';

export type { ProviderFallbackChainEntryV1, ProviderFallbackPolicyV1 } from '@agentos/shared';

export type ProviderFallbackPolicy = ProviderFallbackPolicyV1;

export const MAX_FALLBACK_PROVIDER_CONFIG_IDS = 32;

/**
 * Structural validation for a persisted/API-supplied fallback policy. Returns
 * the normalized policy, or undefined for null/undefined (policy absent).
 * Throws Error with a precise message on malformed input.
 */
export function normalizeProviderFallbackPolicy(value: unknown): ProviderFallbackPolicyV1 | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('PROVIDER_FALLBACK_POLICY_INVALID: fallbackPolicy must be an object');
  }
  const policy = value as Record<string, unknown>;
  if (typeof policy.enabled !== 'boolean') {
    throw new Error('PROVIDER_FALLBACK_POLICY_INVALID: enabled must be a boolean');
  }
  if (!Array.isArray(policy.fallbackProviderConfigIds)
    || !policy.fallbackProviderConfigIds.every(item => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error('PROVIDER_FALLBACK_POLICY_INVALID: fallbackProviderConfigIds must be non-empty strings');
  }
  if (policy.fallbackProviderConfigIds.length > MAX_FALLBACK_PROVIDER_CONFIG_IDS) {
    throw new Error('PROVIDER_FALLBACK_POLICY_INVALID: fallbackProviderConfigIds exceeds the bounded list');
  }
  if (!Array.isArray(policy.triggerErrorCodes)
    || !policy.triggerErrorCodes.every(item => typeof item === 'string' && item.trim().length > 0)) {
    throw new Error('PROVIDER_FALLBACK_POLICY_INVALID: triggerErrorCodes must be non-empty strings');
  }
  for (const code of policy.triggerErrorCodes) {
    if (!(PROVIDER_ERROR_CODES as readonly string[]).includes(code)) {
      throw new Error('PROVIDER_FALLBACK_POLICY_INVALID: unknown triggerErrorCode ' + code);
    }
  }
  if (typeof policy.maxFallbacks !== 'number' || !Number.isSafeInteger(policy.maxFallbacks) || policy.maxFallbacks < 0) {
    throw new Error('PROVIDER_FALLBACK_POLICY_INVALID: maxFallbacks must be a non-negative integer');
  }
  if (typeof policy.requireUserApproval !== 'boolean') {
    throw new Error('PROVIDER_FALLBACK_POLICY_INVALID: requireUserApproval must be a boolean');
  }
  return {
    enabled: policy.enabled,
    fallbackProviderConfigIds: [...policy.fallbackProviderConfigIds] as string[],
    triggerErrorCodes: [...policy.triggerErrorCodes] as string[],
    maxFallbacks: policy.maxFallbacks,
    requireUserApproval: policy.requireUserApproval,
  };
}

/**
 * §42 Fallback Rule: only a normalized Provider error code explicitly listed
 * in triggerErrorCodes triggers an automatic fallback. Unknown or unlisted
 * codes never switch providers (fail closed, no silent fallback).
 */
export function isFallbackTriggerCode(policy: ProviderFallbackPolicyV1, code: string): boolean {
  if (!policy.enabled) return false;
  if (!(PROVIDER_ERROR_CODES as readonly string[]).includes(code)) return false;
  return policy.triggerErrorCodes.includes(code);
}

/**
 * §89 example order: candidates are tried in fallbackProviderConfigIds order,
 * skipping configurations already attempted for this stage (primary plus any
 * prior fallback). Returns undefined when the ordered list is exhausted.
 */
export function selectFallbackTargetId(
  policy: ProviderFallbackPolicyV1,
  attemptedProviderConfigIds: ReadonlySet<string>,
): string | undefined {
  if (!policy.enabled) return undefined;
  for (const candidateId of policy.fallbackProviderConfigIds) {
    if (!attemptedProviderConfigIds.has(candidateId)) return candidateId;
  }
  return undefined;
}

/** Executed switches for one stage, oldest first. */
export function fallbackChainForStage(
  chain: readonly ProviderFallbackChainEntryV1[] | undefined,
  stageId: string,
): readonly ProviderFallbackChainEntryV1[] {
  if (!chain) return [];
  return chain.filter(entry => entry.stageId === stageId);
}

/**
 * §42 budget: at most maxFallbacks switches per stage. A stage whose executed
 * switch count reached the budget fails with its last provider error instead
 * of switching again.
 */
export function fallbackBudgetExhausted(
  policy: ProviderFallbackPolicyV1,
  chain: readonly ProviderFallbackChainEntryV1[] | undefined,
  stageId: string,
): boolean {
  return fallbackChainForStage(chain, stageId).length >= policy.maxFallbacks;
}

/** Ordered provider configuration ids attempted for a stage: primary first. */
export function attemptedProviderConfigIds(
  chain: readonly ProviderFallbackChainEntryV1[] | undefined,
  stageId: string,
  primaryProviderConfigId: string,
): Set<string> {
  const ids = new Set<string>([primaryProviderConfigId]);
  for (const entry of fallbackChainForStage(chain, stageId)) {
    ids.add(entry.toProviderConfigId);
  }
  return ids;
}
